import { FastifyInstance } from 'fastify';
import { proxyStream } from '../services/streamProxy.service.js';

export async function streamRoutes(app: FastifyInstance) {
  app.get('/stream', async (req, reply) => {
    try {
      await proxyStream(reply);
    } catch (err) {
      app.log.error({ err }, 'Stream proxy failed');
      if (!reply.raw.headersSent) {
        reply.code(502).send('Stream unavailable');
      }
    }
  });
}
