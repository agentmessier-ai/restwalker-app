import type { FastifyInstance } from 'fastify'
import { spawn } from 'child_process'
import * as db from '../db.js'
import { S } from './schemas.js'

export default async function utilityRoutes(app: FastifyInstance) {
  app.post('/open-folder', {
    schema: {
      tags: ['utility'],
      summary: 'Open a folder in Finder (macOS only)',
      body: {
        type: 'object',
        properties: { path: { type: 'string', nullable: true } },
      },
      response: { 200: S.ok },
    },
  }, async (req) => {
    const { path: folderPath } = (req.body as { path?: string | null })
    const target = folderPath ?? db.WORKSPACE_DIR
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  })
}
