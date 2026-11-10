import type { RadioUser } from '../services/radioStore.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    radioUser?: RadioUser;
  }
}
