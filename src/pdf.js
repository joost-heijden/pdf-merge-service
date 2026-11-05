import { createHash } from 'node:crypto';
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFInvalidObject } from 'pdf-lib';
import { requireThat, ServiceError } from './errors.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blockedKeys = new Set(['OpenAction', 'AA', 'JavaScript', 'JS', 'EmbeddedFiles', 'EF', 'XFA', 'RichMediaContent']);
const blockedActions = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition']);

function screenObjects(doc) {
  // Conservative structural screening, not a PDF sanitizer or signature validator.
  requireThat(!doc.catalog.has(PDFName.of('AcroForm')), 'PDF_FORM_UNSUPPORTED', 'PDF forms require manual review');
  requireThat(!doc.catalog.has(PDFName.of('OCProperties')), 'PDF_LAYERS_UNSUPPORTED', 'PDF layers require manual review');
  const seen = new Set();
  function walk(obj) {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    requireThat(!(obj instanceof PDFInvalidObject), 'PDF_INVALID', 'Source contains an invalid PDF object');
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        const name = key.decodeText();
        requireThat(name !== 'ByteRange' && !(name === 'Type' && value instanceof PDFName && value.decodeText() === 'Sig'), 'PDF_SIGNATURE_UNSUPPORTED', 'Signed PDFs require manual review');
        requireThat(!blockedKeys.has(name), 'PDF_ACTIVE_CONTENT_UNSUPPORTED', 'PDF contains unsupported active or embedded content');
        requireThat(!(name === 'S' && value instanceof PDFName && blockedActions.has(value.decodeText())), 'PDF_ACTIVE_CONTENT_UNSUPPORTED', 'PDF contains an unsupported action');
        walk(value);
      }
    } else if (obj instanceof PDFArray) {
      for (const value of obj.asArray()) walk(value);
    } else if (obj.dict instanceof PDFDict) {
      walk(obj.dict);
    }
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) walk(object);
}

async function openPdf(bytes) {
  requireThat(bytes.length > 0 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-', 'PDF_INVALID', 'Source is not a PDF file');
  requireThat(Buffer.from(bytes.subarray(-2048)).includes(Buffer.from('%%EOF')), 'PDF_INVALID', 'Source PDF is incomplete');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
  } catch (error) {
    if (error.name === 'EncryptedPDFError' || error.message?.includes('encrypted')) {
      throw new ServiceError('PDF_ENCRYPTED', 'Encrypted PDFs require manual review');
    }
    throw new ServiceError('PDF_INVALID', 'Source PDF could not be parsed');
  }
  requireThat(doc.getPageCount() > 0, 'PDF_EMPTY', 'Source PDF has no pages');
  screenObjects(doc);
  return doc;
}

export async function processPdfJob({ operation, manifest, files, limits }) {
  const sources = new Map();
  const originalManifest = [];
  let sourcePages = 0;
  for (const descriptor of manifest.documents) {
    const file = files.find(f => f.fieldName === descriptor.field_name);
    const bytes = Buffer.from(file.bytes);
    const digest = sha256(bytes);
    requireThat(descriptor.sha256 === undefined || descriptor.sha256 === digest, 'SOURCE_HASH_MISMATCH', 'Source checksum differs from the manifest');
    const doc = await openPdf(bytes);
    sourcePages += doc.getPageCount();
    requireThat(sourcePages <= limits.maxPages, 'PAGE_LIMIT_EXCEEDED', 'Too many source pages', 413);
    sources.set(descriptor.document_id, doc);
    originalManifest.push({ document_id: descriptor.document_id, field_name: descriptor.field_name, sha256: digest, size_bytes: bytes.length, page_count: doc.getPageCount() });
  }
  const base = {
    schema_version: '1', request_id: manifest.request_id, status: 'complete',
    original_manifest: originalManifest, warnings: [],
    checks: { structure: 'parsed', rendering: 'not_checked', text_layer: 'not_checked' },
  };
  if (operation === 'inspect') return base;

  const pages = [];
  const used = new Map([...sources.keys()].map(key => [key, new Set()]));
  for (const part of manifest.ordered_parts) {
    const doc = sources.get(part.document_id);
    const selected = part.pages ?? Array.from({ length: doc.getPageCount() }, (_, i) => i + 1);
    for (const page of selected) {
      requireThat(page <= doc.getPageCount(), 'MERGE_PAGE_OUT_OF_RANGE', 'Plan references a page outside its source document');
      requireThat(!used.get(part.document_id).has(page), 'MERGE_PAGE_DUPLICATED', 'Each source page must occur exactly once');
      used.get(part.document_id).add(page);
      pages.push({ output_page: pages.length + 1, document_id: part.document_id, page });
    }
  }
  requireThat(pages.length === sourcePages && [...sources].every(([key, doc]) => used.get(key).size === doc.getPageCount()), 'MERGE_PAGE_MISSING', 'Every source page must be included exactly once');

  const output = await PDFDocument.create();
  const copied = new Map();
  for (const [documentId, source] of sources) {
    // One copier per source preserves sharing of fonts/images across its pages.
    copied.set(documentId, await output.copyPages(source, source.getPageIndices()));
  }
  for (const entry of pages) output.addPage(copied.get(entry.document_id)[entry.page - 1]);
  // Fixed metadata makes retries byte-reproducible with this dependency version.
  output.setProducer('PDF Merge Service 0.1');
  output.setCreator('PDF Merge Service');
  output.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  output.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  const outputBytes = await output.save();
  requireThat(outputBytes.length <= limits.maxOutputBytes, 'OUTPUT_LIMIT_EXCEEDED', 'Merged PDF exceeds the output size limit', 413);
  const reopened = await PDFDocument.load(outputBytes, { updateMetadata: false, throwOnInvalidObject: true });
  requireThat(reopened.getPageCount() === pages.length, 'OUTPUT_INVALID', 'Merged PDF failed its page count check', 500);
  return {
    ...base, group_id: manifest.group_id,
    output_document: { name: manifest.output_name, mime: 'application/pdf', encoding: 'base64', data_base64: Buffer.from(outputBytes).toString('base64'), sha256: sha256(outputBytes), size_bytes: outputBytes.length, page_count: pages.length },
    page_manifest: pages,
  };
}
