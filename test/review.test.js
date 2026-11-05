import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePdf, multipartPayload, TEST_TOKEN } from './helpers.js';

const config = loadConfig({ PDF_API_TOKEN: TEST_TOKEN });
const manifest = () => ({
  schema_version: '1', request_id: 'review-001', group_id: 'invoice-001', output_name: 'invoice.pdf',
  documents: [{ document_id: 'invoice', field_name: 'doc1' }],
  ordered_parts: [{ document_id: 'invoice' }],
});
const probe = app => app.inject({ method: 'POST', url: '/v1/merge', headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'text/plain' }, payload: 'probe' });

async function waitForProbe(app, expectedStatus) {
  let response;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    response = await probe(app);
    if (response.statusCode === expectedStatus) return response;
    await delay(10);
  }
  assert.equal(response.statusCode, expectedStatus, response.body);
}

async function sharedImagePdf({ pages = 5, imageBytes = 100000 } = {}) {
  const doc = await PDFDocument.create();
  const image = doc.context.register(doc.context.stream(randomBytes(imageBytes), {
    Type: 'XObject', Subtype: 'Image', Width: 100, Height: imageBytes / 100,
    ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([100, imageBytes / 100]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { SharedImage: image } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`q 100 0 0 ${imageBytes / 100} 0 0 cm /SharedImage Do Q`)));
  }
  return Buffer.from(await doc.save());
}

test('multipage PDF retains shared image resources without multiplying output bytes', async () => {
  const bytes = await sharedImagePdf();
  const app = await buildApp({ ...config, maxOutputBytes: bytes.length * 2 });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/merge', ...multipartPayload(manifest(), [['doc1', bytes]]) });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.output_document.page_count, 5);
    assert(result.output_document.size_bytes < bytes.length * 2, 'one shared image should remain shared across the five pages');
    const reopened = await PDFDocument.load(Buffer.from(result.output_document.data_base64, 'base64'));
    assert.equal(reopened.getPageCount(), 5);
  } finally { await app.close(); }
});

test('PDF optional-content layers require manual review rather than changing visibility during merge', async () => {
  const doc = await PDFDocument.load(await makePdf(['LAYERED INVOICE']));
  const group = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden invoice layer') }));
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [group], D: { OFF: [group], Order: [group] } }));
  const bytes = Buffer.from(await doc.save());
  const app = await buildApp(config);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/merge', ...multipartPayload(manifest(), [['doc1', bytes]]) });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'PDF_LAYERS_UNSUPPORTED');
    assert.equal(response.json().output_document, undefined);
  } finally { await app.close(); }
});

for (const [name, contentType, payload] of [
  ['missing boundary', 'multipart/form-data', 'broken'],
  ['truncated multipart body', 'multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n{}'],
]) {
  test(`malformed multipart is a client error: ${name}`, async () => {
    const app = await buildApp(config);
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/merge', headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': contentType }, payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, 'UPLOAD_INVALID');
      assert.equal(response.json().output_document, undefined);
    } finally { await app.close(); }
  });
}

test('aborted real HTTP upload releases admission for the next request', { timeout: 10000 }, async () => {
  const app = await buildApp({ ...config, maxConcurrent: 1 });
  let upload;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    upload = httpRequest(`${address}/v1/merge`, { method: 'POST', headers: {
      authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'multipart/form-data; boundary=AbortTest',
    } });
    upload.on('error', () => {});
    upload.write('--AbortTest\r\nContent-Disposition: form-data; name="doc1"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n');
    await waitForProbe(app, 503);
    const closed = new Promise(resolve => upload.once('close', resolve));
    upload.destroy();
    await closed;
    await waitForProbe(app, 415);
    const response = await app.inject({ method: 'POST', url: '/v1/merge', ...multipartPayload(manifest(), [['doc1', await makePdf()]]) });
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    upload?.destroy();
    app.server.closeAllConnections();
    await app.close();
  }
});

test('a stalled real HTTP response keeps admission until client disconnects', { timeout: 15000 }, async () => {
  const app = await buildApp({ ...config, maxConcurrent: 1 });
  let download, response;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const upload = multipartPayload(manifest(), [['doc1', await sharedImagePdf({ pages: 1, imageBytes: 5000000 })]]);
    response = await new Promise((resolve, reject) => {
      download = httpRequest(`${address}/v1/merge`, { method: 'POST', headers: { ...upload.headers, 'content-length': upload.payload.length } }, incoming => {
        incoming.pause();
        resolve(incoming);
      });
      download.once('error', reject);
      download.end(upload.payload);
    });
    assert.equal(response.statusCode, 200);
    assert.equal((await probe(app)).statusCode, 503, 'an unfinished large response must retain the concurrency slot');
    const closed = new Promise(resolve => download.once('close', resolve));
    response.destroy();
    download.destroy();
    await closed;
    await waitForProbe(app, 415);
  } finally {
    response?.destroy();
    download?.destroy();
    app.server.closeAllConnections();
    await app.close();
  }
});
