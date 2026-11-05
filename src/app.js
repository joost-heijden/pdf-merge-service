import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { ServiceError, requireThat } from './errors.js';
import { validateManifest } from './manifest.js';
import { runPdfJob } from './worker.js';

const MANIFEST_LIMIT = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest();

async function readUpload(request, operation, config) {
  requireThat(request.isMultipart(), 'CONTENT_TYPE_INVALID', 'Use multipart/form-data', 415);
  const wireLimit = config.maxInputBytes + MANIFEST_LIMIT + 128 * 1024;
  requireThat(!request.headers['content-length'] || Number(request.headers['content-length']) <= wireLimit, 'INPUT_LIMIT_EXCEEDED', 'Upload exceeds the request size limit', 413);
  const files = [];
  let manifest;
  let total = 0;
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      requireThat(part.fieldname === 'manifest' && manifest === undefined && !part.valueTruncated && typeof part.value === 'string', 'MANIFEST_INVALID', 'Supply exactly one manifest JSON field', 400);
      try { manifest = JSON.parse(part.value); }
      catch { throw new ServiceError('MANIFEST_INVALID', 'Manifest is not valid JSON', 400); }
    } else {
      requireThat(part.fieldname !== 'manifest' && !files.some(file => file.fieldName === part.fieldname), 'UPLOAD_INVALID', 'File fields must be unique', 400);
      const chunks = [];
      for await (const chunk of part.file) {
        total += chunk.length;
        requireThat(total <= config.maxInputBytes, 'INPUT_LIMIT_EXCEEDED', 'Combined source files exceed the input size limit', 413);
        chunks.push(chunk);
      }
      requireThat(!part.file.truncated, 'INPUT_LIMIT_EXCEEDED', 'A source file exceeds the input size limit', 413);
      files.push({ fieldName: part.fieldname, bytes: Buffer.concat(chunks) });
    }
  }
  validateManifest(manifest, operation, config);
  const expected = new Set(manifest.documents.map(doc => doc.field_name));
  requireThat(files.length === expected.size && files.every(file => expected.has(file.fieldName)), 'UPLOAD_MANIFEST_MISMATCH', 'Uploaded files must exactly match the manifest', 400);
  return { operation, manifest, files, limits: { maxPages: config.maxPages, maxOutputBytes: config.maxOutputBytes } };
}

export async function buildApp(config, { auditLog = undefined } = {}) {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), requestIdHeader: false, requestTimeout: config.requestTimeoutMs, connectionTimeout: config.requestTimeoutMs, bodyLimit: MANIFEST_LIMIT });
  await app.register(multipart, { limits: { fields: 1, files: config.maxDocuments, parts: config.maxDocuments + 1, fileSize: config.maxInputBytes, fieldSize: MANIFEST_LIMIT, fieldNameSize: 64, headerPairs: 100 }, throwFileSizeLimit: true });
  const expectedToken = hash(`Bearer ${config.token}`);
  let active = 0;
  app.addHook('onRequest', async (request, reply) => {
    request.startedAt = Date.now();
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('X-Request-Id', request.id);
    if (request.routeOptions.url?.startsWith('/v1/')) {
      const auth = request.headers.authorization;
      requireThat(typeof auth === 'string' && timingSafeEqual(hash(auth), expectedToken), 'UNAUTHORIZED', 'A valid Bearer token is required', 401);
      requireThat(active < config.maxConcurrent, 'SERVICE_BUSY', 'PDF service is busy; retry later', 503);
      active += 1;
      request.slotHeld = true;
      request.processingDone = true;
      request.responseDone = false;
      request.releasePdfSlot = () => {
        if (request.slotHeld && request.processingDone && request.responseDone) {
          active -= 1;
          request.slotHeld = false;
        }
      };
      reply.raw.once('close', () => {
        request.responseDone = true;
        request.releasePdfSlot();
      });
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    request.responseDone = true;
    request.releasePdfSlot?.();
    auditLog?.({ request_id: request.id, status_code: reply.statusCode, duration_ms: Date.now() - request.startedAt });
  });
  app.setErrorHandler((error, request, reply) => {
    let code = error.code || 'INTERNAL_ERROR';
    let status = error.statusCode || 500;
    let message = error instanceof ServiceError ? error.message : 'Request could not be processed';
    if (/^FST_.*LIMIT/.test(code)) { code = 'INPUT_LIMIT_EXCEEDED'; status = 413; message = 'Multipart upload exceeds its limits'; }
    else if (code === 'ERR_STREAM_PREMATURE_CLOSE') { code = 'UPLOAD_INVALID'; status = 400; }
    else if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') { code = 'CONTENT_TYPE_INVALID'; status = 415; }
    else if (!(error instanceof ServiceError)) { code = status < 500 ? 'UPLOAD_INVALID' : 'INTERNAL_ERROR'; }
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (status === 503) reply.header('Retry-After', '2');
    reply.code(status).send({ schema_version: '1', status: 'rejected', request_id: request.id, error: { code, message } });
  });
  app.get('/healthz', async () => ({ status: 'ok', schema_version: '1' }));
  for (const operation of ['inspect', 'merge']) {
    app.post(`/v1/${operation}`, async (request, reply) => {
      request.processingDone = false;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      const close = () => { if (!reply.raw.writableEnded) cancel(); };
      request.raw.once('aborted', cancel);
      reply.raw.once('close', close);
      try {
        let job;
        try { job = await readUpload(request, operation, config); }
        catch (error) {
          if (error instanceof ServiceError || error.code?.startsWith('FST_')) throw error;
          throw new ServiceError('UPLOAD_INVALID', 'Malformed or interrupted multipart upload', 400);
        }
        return await runPdfJob(job, { timeoutMs: config.jobTimeoutMs, signal: abort.signal });
      } finally {
        request.raw.removeListener('aborted', cancel);
        reply.raw.removeListener('close', close);
        request.processingDone = true;
        request.releasePdfSlot?.();
      }
    });
  }
  return app;
}
