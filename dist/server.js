import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startIcecastIngest } from './services/icecastIngest.service.js';
const app = await buildApp();
try {
    await startIcecastIngest(app.log);
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
}
catch (err) {
    app.log.error({ err }, 'Failed to start server');
    await app.close();
    process.exit(1);
}
