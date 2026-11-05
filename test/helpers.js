import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib';

export const TEST_TOKEN = 'test-only-token-0123456789abcdef0123456789';

export async function makePdf(labels = ['SOURCE PAGE'], kind) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  labels.forEach(label => {
    const page = doc.addPage([595, 842]);
    page.drawText(label, { x: 50, y: 740, size: 24, font });
  });
  if (kind === 'form') {
    const field = doc.getForm().createTextField('amount');
    field.setText('42.00');
    field.addToPage(doc.getPages()[0], { x: 50, y: 600, width: 200, height: 25 });
  }
  if (kind === 'signature') {
    doc.context.register(doc.context.obj({ Type: PDFName.of('Sig'), ByteRange: [0, 1, 2, 3] }));
  }
  if (kind === 'action') {
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert(1)') }));
  }
  if (kind === 'encrypted') {
    // Intentionally only an encryption marker; real encrypted PDFs are also checked by the external QA script.
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: PDFName.of('Standard') }));
  }
  return Buffer.from(await doc.save());
}

export function mergeManifest() {
  return { schema_version: '1', request_id: 'test-001', group_id: 'test-invoice', output_name: 'test-invoice.pdf', documents: [{ document_id: 'invoice', field_name: 'doc1' }, { document_id: 'appendix', field_name: 'doc2' }], ordered_parts: [{ document_id: 'invoice' }, { document_id: 'appendix' }] };
}

export function multipartPayload(manifest, files, { extraFields = [], withManifest = true } = {}) {
  const boundary = 'FinanceTestBoundary7x9';
  const chunks = [];
  const field = (name, value) => chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  if (withManifest) field('manifest', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, bytes] of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="upload.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), bytes, Buffer.from('\r\n'));
  }
  for (const [name, value] of extraFields) field(name, value);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${TEST_TOKEN}` }, payload: Buffer.concat(chunks) };
}
