import { Worker } from 'node:worker_threads';
import { ServiceError } from './errors.js';

export function runPdfJob(job, { timeoutMs, signal, workerUrl = new URL('./pdf-worker.js', import.meta.url) }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }, stdout: true, stderr: true });
    // PDF parser warnings must not put document content in the process logs.
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Keep the admission slot until termination completes, including timeout.
      void worker.terminate().finally(() => error ? reject(error) : resolve(value));
    };
    const abort = () => finish(new ServiceError('REQUEST_ABORTED', 'Request was aborted', 400));
    const timer = setTimeout(() => finish(new ServiceError('PROCESSING_TIMEOUT', 'PDF processing exceeded its time limit', 504)), timeoutMs);
    worker.once('message', message => {
      if (message.error) finish(new ServiceError(message.error.code, message.error.message, message.error.statusCode));
      else finish(null, message.result);
    });
    worker.once('error', () => finish(new ServiceError('PROCESSING_FAILED', 'PDF worker failed or exceeded its memory limit', 422)));
    worker.once('exit', () => { if (!done) finish(new ServiceError('PROCESSING_FAILED', 'PDF worker exited without a result', 422)); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
