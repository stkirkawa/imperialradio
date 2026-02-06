import { FastifyInstance } from 'fastify';
export async function publicRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    return reply.sendFile('index.html');
  });

  app.get('/policy', async (req, reply) => {
    return reply.sendFile('policy.html');
  });

  app.get('/api/health', async () => ({ ok: true }));
}
