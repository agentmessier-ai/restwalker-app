import type { FastifyInstance } from 'fastify'

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', {
    schema: {
      tags: ['health'],
      summary: 'Health check',
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async () => ({ ok: true }))

  app.get('/', async (_req, reply) => reply.sendFile('index.html'))
}
