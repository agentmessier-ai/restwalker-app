import type { FastifyInstance } from 'fastify'
import * as db from '../db.js'
import type { Settings } from '../db.js'
import { S } from './schemas.js'

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', {
    schema: {
      tags: ['settings'],
      summary: 'Get all settings',
      response: {
        200: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  }, async () => db.getSettings())

  app.post('/settings', {
    schema: {
      tags: ['settings'],
      summary: 'Update one or more settings',
      body: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, settings: { type: 'object', additionalProperties: { type: 'string' } } } },
        422: S.error,
      },
    },
  }, async (req, reply) => {
    try {
      db.updateSettings(req.body as Partial<Settings>)
      return { ok: true, settings: db.getSettings() }
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message })
    }
  })
}
