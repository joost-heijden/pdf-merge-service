import { requireThat } from './errors.js';

const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = (x) => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\x00-\x1F\x7F]/.test(x);
function keys(value, allowed) {
  requireThat(Object.keys(value).every((key) => allowed.includes(key)), 'MANIFEST_INVALID', 'Unknown manifest property', 400);
}

export function validateManifest(m, operation, limits) {
  requireThat(plain(m), 'MANIFEST_INVALID', 'Manifest must be an object', 400);
  keys(m, operation === 'merge' ? ['schema_version', 'request_id', 'documents', 'group_id', 'output_name', 'ordered_parts'] : ['schema_version', 'request_id', 'documents']);
  requireThat(m.schema_version === '1' && typeof m.request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(m.request_id), 'MANIFEST_INVALID', 'Use schema_version 1 and an opaque request_id of at most 80 safe ASCII characters', 400);
  requireThat(Array.isArray(m.documents) && m.documents.length > 0, 'MANIFEST_INVALID', 'At least one document is required', 400);
  requireThat(m.documents.length <= limits.maxDocuments, 'DOCUMENT_LIMIT_EXCEEDED', 'Too many source documents', 413);
  const ids = new Set();
  const fields = new Set();
  for (const doc of m.documents) {
    requireThat(plain(doc), 'MANIFEST_INVALID', 'Invalid document entry', 400);
    keys(doc, ['document_id', 'field_name', 'sha256']);
    requireThat(id(doc.document_id) && typeof doc.field_name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(doc.field_name) && doc.field_name !== 'manifest', 'MANIFEST_INVALID', 'Invalid document ID or upload field', 400);
    requireThat(!ids.has(doc.document_id) && !fields.has(doc.field_name), 'MANIFEST_INVALID', 'Document IDs and upload fields must be unique', 400);
    requireThat(doc.sha256 === undefined || (typeof doc.sha256 === 'string' && /^[a-f0-9]{64}$/.test(doc.sha256)), 'MANIFEST_INVALID', 'Invalid SHA-256 value', 400);
    ids.add(doc.document_id);
    fields.add(doc.field_name);
  }
  if (operation === 'merge') {
    requireThat(id(m.group_id), 'MERGE_PLAN_INVALID', 'A single invoice group_id is required', 400);
    requireThat(typeof m.output_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,114}\.pdf$/.test(m.output_name), 'MERGE_PLAN_INVALID', 'Use a safe PDF output_name without paths', 400);
    requireThat(Array.isArray(m.ordered_parts) && m.ordered_parts.length > 0 && m.ordered_parts.length <= limits.maxPages, 'MERGE_PLAN_INVALID', 'An explicit ordered_parts list is required', 400);
    for (const part of m.ordered_parts) {
      requireThat(plain(part), 'MERGE_PLAN_INVALID', 'Invalid ordered part', 400);
      keys(part, ['document_id', 'pages']);
      requireThat(ids.has(part.document_id), 'MERGE_PLAN_INVALID', 'Plan references an unknown source document', 400);
      requireThat(part.pages === undefined || (Array.isArray(part.pages) && part.pages.length > 0 && part.pages.length <= limits.maxPages && part.pages.every(p => Number.isSafeInteger(p) && p > 0)), 'MERGE_PLAN_INVALID', 'Pages must be positive integers; omit pages to use all source pages', 400);
    }
  }
  return m;
}
