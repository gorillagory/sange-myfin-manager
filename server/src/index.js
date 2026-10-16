import { createAuth, authConfig } from './auth.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { buildApp } from './app.js';
import { installShutdown } from './shutdown.js';
import { createPaymentGatewayRuntime } from './payment-gateways.js';
import { receiptEmailFeatureEnabled } from './receipt-emails.js';

let app;
let shutdown;
try {
  const config = loadConfig();
  const database = createDatabase(config.database, {
    onError: event => process.stderr.write(`${event}\n`)
  });
  const authOptions = authConfig();
  const auth = createAuth(database.pool, authOptions);
  const paymentGateway = createPaymentGatewayRuntime(process.env);
  app = buildApp({ database, auth, authOptions, paymentGateway,
    receiptEmailEnabled:receiptEmailFeatureEnabled(process.env),
    uploadDir: process.env.UPLOAD_DIR || '/app/uploads', logger: { level: 'info' } });
  shutdown = installShutdown(app, { timeoutMs: config.shutdownTimeoutMs });
  await app.listen({ host: config.host, port: config.port });
} catch {
  process.stderr.write('API startup failed: check configuration and listener availability.\n');
  if (shutdown) await shutdown.stop();
  else if (app) await app.close();
  process.exitCode = 1;
}
