import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
} catch (err) {
  app.log.error({ err }, 'Failed to start server');
  process.exit(1);
}
