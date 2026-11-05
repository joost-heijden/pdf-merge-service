import { parentPort, workerData } from 'node:worker_threads';
import { processPdfJob } from './pdf.js';

try {
  parentPort.postMessage({ result: await processPdfJob(workerData) });
} catch (error) {
  parentPort.postMessage({ error: { code: error.code || 'PDF_INVALID', message: error.code ? error.message : 'PDF processing failed', statusCode: error.statusCode || 422 } });
}
