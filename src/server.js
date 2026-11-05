import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = await buildApp(config, { auditLog: entry => process.stdout.write(`${JSON.stringify(entry)}\n`) });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => { await app.close(); process.exit(0); });
  }
  await app.listen({ port: config.port, host: config.host });
  process.stdout.write('PDF Merge Service ready\n');
} catch (error) {
  // Configuration errors contain no credential values; other startup details stay private.
  process.stderr.write(`${error.message.startsWith('PDF_') || error.message.startsWith('PORT ') ? error.message : 'PDF service could not start'}\n`);
  process.exitCode = 1;
}
