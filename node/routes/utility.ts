import type { FastifyInstance } from 'fastify'
import { spawn } from 'child_process'
import * as db from '../db.js'
import { S } from './schemas.js'

export default async function utilityRoutes(app: FastifyInstance) {
  app.post('/open-folder', {
    schema: {
      tags: ['utility'],
      summary: 'Open a folder in Finder, or reveal a file in its folder (macOS only)',
      body: {
        type: 'object',
        properties: {
          path:   { type: 'string', nullable: true },
          reveal: { type: 'boolean', description: 'Reveal & select the path in its containing folder (open -R) instead of opening it' },
        },
      },
      response: { 200: S.ok },
    },
  }, async (req) => {
    const { path: folderPath, reveal } = (req.body as { path?: string | null; reveal?: boolean })
    const target = folderPath ?? db.WORKSPACE_DIR
    // -R reveals a file selected in Finder; without it, open a folder directly
    const args = reveal && folderPath ? ['-R', target] : [target]
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  })
}
