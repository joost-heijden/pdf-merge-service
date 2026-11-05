import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePdf, mergeManifest, multipartPayload, TEST_TOKEN } from './helpers.js';

let app, invoice, appendix;
const config = loadConfig({ PDF_API_TOKEN: TEST_TOKEN });
before(async () => {
  app = await buildApp(config);
  invoice = await makePdf(['INVOICE PAGE 1', 'INVOICE PAGE 2']);
  appendix = await makePdf(['APPENDIX PAGE 1']);
});
after(async () => { await app.close(); });
const files = () => [['doc2', appendix], ['doc1', invoice]]; // Deliberately reverse upload order.
const post = (manifest, uploadFiles = files(), target = app, route = 'merge', options) => target.inject({ method: 'POST', url: `/v1/${route}`, ...multipartPayload(manifest, uploadFiles, options) });
function rejected(response, code, status = 422) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code, response.body);
  assert.equal(response.json().output_document, undefined);
}

test('health is public and contains no document information', async () => {
  const response = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', schema_version: '1' });
  assert.equal(response.headers['cache-control'], 'no-store');
});

for (const authorization of [undefined, 'Bearer wrong']) {
  test(`invalid auth rejects before attempting malformed body: ${authorization ?? 'missing'}`, async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/merge', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' }, payload: '{not JSON' });
    rejected(response, 'UNAUTHORIZED', 401);
  });
}

test('merge returns real, reopenable PDF bytes, hashes, full page provenance, and explicit order', async () => {
  const response = await post(mergeManifest());
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const bytes = Buffer.from(result.output_document.data_base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(result.output_document.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.output_document.size_bytes, bytes.length);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  assert.deepEqual(result.page_manifest, [{ output_page: 1, document_id: 'invoice', page: 1 }, { output_page: 2, document_id: 'invoice', page: 2 }, { output_page: 3, document_id: 'appendix', page: 1 }]);
  assert.equal(result.original_manifest[0].sha256, createHash('sha256').update(invoice).digest('hex'));
  assert.equal(result.checks.text_layer, 'not_checked');
});

test('same bytes and plan produce the same bytes on retry', async () => {
  const first = (await post(mergeManifest())).json();
  const second = (await post(mergeManifest())).json();
  assert.equal(first.output_document.sha256, second.output_document.sha256);
});

test('explicit page reordering is followed', async () => {
  const m = mergeManifest();
  m.ordered_parts = [{ document_id: 'appendix' }, { document_id: 'invoice', pages: [2, 1] }];
  const response = await post(m);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().page_manifest.map(p => [p.document_id, p.page]), [['appendix', 1], ['invoice', 2], ['invoice', 1]]);
});

test('inspect computes source metadata without creating output', async () => {
  const { schema_version, request_id, documents } = mergeManifest();
  const response = await post({ schema_version, request_id, documents }, files(), app, 'inspect');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().original_manifest.map(d => d.page_count), [2, 1]);
  assert.equal(response.json().output_document, undefined);
});

const manifestCases = [
  ['reject absent page', m => { m.ordered_parts[0].pages = [1]; }, 'MERGE_PAGE_MISSING'],
  ['reject duplicated page', m => { m.ordered_parts[0].pages = [1, 1, 2]; }, 'MERGE_PAGE_DUPLICATED'],
  ['reject repeated whole document', m => { m.ordered_parts.push({ document_id: 'invoice' }); }, 'MERGE_PAGE_DUPLICATED'],
  ['reject out of range page', m => { m.ordered_parts[0].pages = [1, 3]; }, 'MERGE_PAGE_OUT_OF_RANGE'],
  ['reject unknown document in plan', m => { m.ordered_parts[0].document_id = 'other'; }, 'MERGE_PLAN_INVALID', 400],
  ['reject negative page', m => { m.ordered_parts[0].pages = [-1]; }, 'MERGE_PLAN_INVALID', 400],
  ['reject empty plan', m => { m.ordered_parts = []; }, 'MERGE_PLAN_INVALID', 400],
  ['reject output path', m => { m.output_name = '../invoice.pdf'; }, 'MERGE_PLAN_INVALID', 400],
  ['reject missing invoice group', m => { delete m.group_id; }, 'MERGE_PLAN_INVALID', 400],
  ['reject extra properties', m => { m.ignore_errors = true; }, 'MANIFEST_INVALID', 400],
  ['reject duplicate IDs', m => { m.documents[1].document_id = 'invoice'; }, 'MANIFEST_INVALID', 400],
  ['reject duplicate fields', m => { m.documents[1].field_name = 'doc1'; }, 'MANIFEST_INVALID', 400],
  ['reject source hash mismatch', m => { m.documents[0].sha256 = '0'.repeat(64); }, 'SOURCE_HASH_MISMATCH'],
];
for (const [name, edit, code, status = 422] of manifestCases) {
  test(name, async () => { const m = mergeManifest(); edit(m); rejected(await post(m), code, status); });
}

test('reject missing upload', async () => rejected(await post(mergeManifest(), [['doc1', invoice]]), 'UPLOAD_MANIFEST_MISMATCH', 400));
test('reject extra upload', async () => rejected(await post(mergeManifest(), [...files(), ['doc3', appendix]]), 'UPLOAD_MANIFEST_MISMATCH', 400));
test('reject duplicate upload field', async () => rejected(await post(mergeManifest(), [...files(), ['doc1', invoice]]), 'UPLOAD_INVALID', 400));
test('reject invalid manifest JSON', async () => rejected(await post('{broken'), 'MANIFEST_INVALID', 400));
test('reject missing manifest', async () => rejected(await post(mergeManifest(), files(), app, 'merge', { withManifest: false }), 'MANIFEST_INVALID', 400));
test('reject second manifest', async () => rejected(await post(mergeManifest(), files(), app, 'merge', { extraFields: [['manifest', '{}']] }), 'INPUT_LIMIT_EXCEEDED', 413));
test('reject unsupported content type', async () => rejected(await app.inject({ method: 'POST', url: '/v1/merge', headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'text/plain' }, payload: 'hello' }), 'CONTENT_TYPE_INVALID', 415));

for (const [name, bytes] of [['image masquerading as PDF', Buffer.from([0x89, 0x50, 0x4e, 0x47])], ['truncated PDF', Buffer.from('%PDF-1.7\ntruncated')], ['malformed PDF', Buffer.from('%PDF-1.7\nnot PDF objects\n%%EOF')], ['empty upload', Buffer.alloc(0)]]) {
  test(`reject ${name}`, async () => rejected(await post(mergeManifest(), [['doc1', bytes], ['doc2', appendix]]), 'PDF_INVALID'));
}
for (const [kind, code] of [['form', 'PDF_FORM_UNSUPPORTED'], ['signature', 'PDF_SIGNATURE_UNSUPPORTED'], ['action', 'PDF_ACTIVE_CONTENT_UNSUPPORTED']]) {
  test(`reject ${kind} PDF`, async () => rejected(await post(mergeManifest(), [['doc1', await makePdf(['REVIEW'], kind)], ['doc2', appendix]]), code));
}

test('reject a real password-encrypted PDF', async () => {
  const bytes = await readFile(new URL('./fixtures/encrypted.pdf', import.meta.url));
  rejected(await post(mergeManifest(), [['doc1', bytes], ['doc2', appendix]]), 'PDF_ENCRYPTED');
});
test('image-only scan PDF is allowed without assuming a text layer', async () => {
  const scan = await readFile(new URL('../examples/scan-bijlage.pdf', import.meta.url));
  const result = await post(mergeManifest(), [['doc1', invoice], ['doc2', scan]]);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().output_document.page_count, 3);
  assert.equal(result.json().checks.text_layer, 'not_checked');
});
test('a supplied correct source checksum is accepted', async () => {
  const manifest = mergeManifest();
  manifest.documents[0].sha256 = createHash('sha256').update(invoice).digest('hex');
  assert.equal((await post(manifest)).statusCode, 200);
});
test('oversized manifest is rejected', async () => {
  rejected(await post(' '.repeat(70 * 1024)), 'MANIFEST_INVALID', 400);
});
test('individual file bytes limit is enforced', async () => {
  const limited = await buildApp({ ...config, maxInputBytes: 100 });
  try { rejected(await post(mergeManifest(), files(), limited), 'INPUT_LIMIT_EXCEEDED', 413); }
  finally { await limited.close(); }
});

test('reject zero-page PDF', async () => {
  const bytes = Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
  rejected(await post(mergeManifest(), [['doc1', bytes], ['doc2', appendix]]), 'PDF_EMPTY');
});

test('aggregate bytes limit is enforced across individually smaller files', async () => {
  const limited = await buildApp({ ...config, maxInputBytes: Math.max(invoice.length, appendix.length) + 10 });
  try { rejected(await post(mergeManifest(), files(), limited), 'INPUT_LIMIT_EXCEEDED', 413); }
  finally { await limited.close(); }
});
test('file count limit is enforced', async () => {
  const limited = await buildApp({ ...config, maxDocuments: 1 });
  try { rejected(await post(mergeManifest(), files(), limited), 'INPUT_LIMIT_EXCEEDED', 413); }
  finally { await limited.close(); }
});
test('total page limit is enforced', async () => {
  const limited = await buildApp({ ...config, maxPages: 2 });
  try { rejected(await post(mergeManifest(), files(), limited), 'PAGE_LIMIT_EXCEEDED', 413); }
  finally { await limited.close(); }
});
test('decoded output size limit is enforced', async () => {
  const limited = await buildApp({ ...config, maxOutputBytes: 100 });
  try { rejected(await post(mergeManifest(), files(), limited), 'OUTPUT_LIMIT_EXCEEDED', 413); }
  finally { await limited.close(); }
});
test('worker timeout returns an explicit error and releases its admission slot', async () => {
  const limited = await buildApp({ ...config, jobTimeoutMs: 1, maxConcurrent: 1 });
  try {
    rejected(await post(mergeManifest(), files(), limited), 'PROCESSING_TIMEOUT', 504);
    rejected(await post(mergeManifest(), files(), limited), 'PROCESSING_TIMEOUT', 504);
  } finally { await limited.close(); }
});
test('busy service refuses parallel requests rather than growing a queue', async () => {
  const limited = await buildApp({ ...config, maxConcurrent: 1 });
  try {
    const responses = await Promise.all([post(mergeManifest(), files(), limited), post(mergeManifest(), files(), limited)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 503]);
  } finally { await limited.close(); }
});
test('logs contain operational fields only', async () => {
  const logs = [];
  const logged = await buildApp(config, { auditLog: event => logs.push(event) });
  try {
    await post(mergeManifest(), files(), logged);
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0]).sort(), ['duration_ms', 'request_id', 'status_code']);
    assert.equal(logs[0].status_code, 200);
    assert(!JSON.stringify(logs).includes(TEST_TOKEN));
    assert(!JSON.stringify(logs).includes('invoice'));
  } finally { await logged.close(); }
});
test('startup fails closed without a strong token or with excessive limits', () => {
  for (const token of [undefined, 'short', 'contains spaces'.repeat(3)]) assert.throws(() => loadConfig({ PDF_API_TOKEN: token }));
  assert.throws(() => loadConfig({ PDF_API_TOKEN: TEST_TOKEN, PDF_MAX_DOCUMENTS: '21' }));
  assert.throws(() => loadConfig({ PDF_API_TOKEN: TEST_TOKEN, PDF_MAX_INPUT_BYTES: '-1' }));
});
