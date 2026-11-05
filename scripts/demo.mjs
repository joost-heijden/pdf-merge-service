import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(process.argv[2] || resolve(project, 'work/demo'));
const token = randomBytes(32).toString('hex');
const app = await buildApp(loadConfig({ PDF_API_TOKEN: token }));
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const manifest = JSON.parse(await readFile(resolve(project, 'examples/manifest.json'), 'utf8'));
  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  // The scan is uploaded first; the manifest puts it last.
  form.set('doc2', new Blob([await readFile(resolve(project, 'examples/scan-bijlage.pdf'))], { type: 'application/pdf' }), 'scan.pdf');
  form.set('doc1', new Blob([await readFile(resolve(project, 'examples/factuur.pdf'))], { type: 'application/pdf' }), 'factuur.pdf');
  const response = await fetch(`${address}/v1/merge`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Demo failed: ${result.error?.code}`);
  const { data_base64, ...metadata } = result.output_document;
  const bytes = Buffer.from(data_base64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256 || bytes.length !== metadata.size_bytes || metadata.page_count !== 3) throw new Error('Demo output verification failed');
  await mkdir(target, { recursive: true });
  await writeFile(resolve(target, metadata.name), bytes);
  await writeFile(resolve(target, 'controleverslag.json'), JSON.stringify({ ...result, output_document: metadata }, null, 2) + '\n');
  console.log(`Demo passed: 2 source PDFs -> ${metadata.page_count} pages. Output: ${target}`);
} finally {
  await app.close();
}
