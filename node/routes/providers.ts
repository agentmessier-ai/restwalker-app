import type { FastifyInstance } from 'fastify'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import * as db from '../db.js'
import * as scheduler from '../scheduler.js'
import { S } from './schemas.js'

export default async function providersRoutes(app: FastifyInstance) {
  app.get('/providers', {
    schema: {
      tags: ['providers'],
      summary: 'List all agent providers',
      response: { 200: { type: 'object', properties: { providers: { type: 'array', items: S.provider } } } },
    },
  }, async () => ({ providers: db.getProviders() }))

  app.post('/providers', {
    schema: {
      tags: ['providers'],
      summary: 'Add an agent provider',
      body: {
        type: 'object',
        required: ['name', 'command'],
        properties: {
          name:         { type: 'string' },
          command:      { type: 'string' },
          args_template:{ type: 'string', description: 'JSON string array with {{task}}, {{model}}, {{cwd}} placeholders' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, provider: S.provider } },
        400: S.error,
      },
    },
  }, async (req, reply) => {
    const { name, command, args_template } = req.body as { name?: string; command?: string; args_template?: string }
    if (!name?.trim() || !command?.trim()) return reply.code(400).send({ error: 'name and command required' })
    const provider = db.addProvider(name.trim(), command.trim(), args_template?.trim() || '["{{task}}"]')
    return { ok: true, provider }
  })

  app.put('/providers/:id', {
    schema: {
      tags: ['providers'],
      summary: 'Update an agent provider',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        properties: {
          name:         { type: 'string' },
          command:      { type: 'string' },
          args_template:{ type: 'string' },
        },
      },
      response: { 200: S.ok, 404: S.error },
    },
  }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id)
    if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
    const { name, command, args_template } = req.body as Partial<db.Provider>
    db.updateProvider(id, { name, command, args_template })
    return { ok: true }
  })

  app.post('/providers/:id/default', {
    schema: {
      tags: ['providers'],
      summary: 'Set a provider as the default',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: S.ok, 404: S.error },
    },
  }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id)
    if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
    db.setDefaultProvider(id)
    return { ok: true }
  })

  app.delete('/providers/:id', {
    schema: {
      tags: ['providers'],
      summary: 'Delete an agent provider',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: S.ok, 404: S.error, 409: S.error },
    },
  }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id)
    if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
    if (db.getProviders().length <= 1) return reply.code(409).send({ error: 'cannot delete last provider' })
    db.deleteProvider(id)
    return { ok: true }
  })

  // ── Discovery ──────────────────────────────────────────────────────────────────

  app.get('/projects', {
    schema: {
      tags: ['discovery'],
      summary: 'List Claude Code projects from history, sorted by recency',
      response: {
        200: {
          type: 'object',
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cwd:         { type: 'string' },
                  last_active: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const historyFile = join(homedir(), '.claude', 'history.jsonl')
    if (!existsSync(historyFile)) return { projects: [] }

    const seen = new Map<string, number>()
    try {
      const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        const d = JSON.parse(line) as { project?: string; timestamp?: number }
        const p = d.project?.trim()
        if (!p || !existsSync(p)) continue
        const ts = d.timestamp ?? 0
        if (ts > (seen.get(p) ?? 0)) seen.set(p, ts)
      }
    } catch { return { projects: [] } }

    return {
      home: homedir(),
      projects: [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd, ts]) => ({ cwd, last_active: new Date(ts).toISOString() }))
    }
  })

  app.get('/models', {
    schema: {
      tags: ['discovery'],
      summary: 'List available Anthropic models from the live API',
      response: {
        200: {
          type: 'object',
          properties: {
            models: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
            },
          },
        },
        502: S.error,
        503: S.error,
      },
    },
  }, async (_req, reply) => {
    const token = scheduler.readKeychainToken()
    if (!token) return reply.code(503).send({ error: 'no auth token' })
    try {
      const res  = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'Authorization': `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      })
      const data = await res.json() as { data: { id: string; display_name: string }[] }
      return { models: data.data.map(m => ({ id: m.id, name: m.display_name })) }
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message })
    }
  })
}
