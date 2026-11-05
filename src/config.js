const MiB = 1024 * 1024;

function integer(env, name, fallback, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const token = env.PDF_API_TOKEN;
  if (typeof token !== 'string' || !/^[\x21-\x7E]{32,512}$/.test(token)) {
    throw new Error('PDF_API_TOKEN must contain 32 to 512 printable ASCII characters without spaces');
  }
  return {
    token,
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 3000, 65535),
    maxDocuments: integer(env, 'PDF_MAX_DOCUMENTS', 20, 20),
    maxInputBytes: integer(env, 'PDF_MAX_INPUT_BYTES', 20 * MiB, 20 * MiB),
    maxOutputBytes: integer(env, 'PDF_MAX_OUTPUT_BYTES', 20 * MiB, 20 * MiB),
    maxPages: integer(env, 'PDF_MAX_PAGES', 500, 500),
    jobTimeoutMs: integer(env, 'PDF_JOB_TIMEOUT_MS', 10_000, 60_000),
    maxConcurrent: integer(env, 'PDF_MAX_CONCURRENT', 2, 4),
    requestTimeoutMs: integer(env, 'PDF_REQUEST_TIMEOUT_MS', 30_000, 120_000),
  };
}
