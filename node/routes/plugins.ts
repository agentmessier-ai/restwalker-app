import type { FastifyInstance } from 'fastify'
import { plugins } from '../plugins.js'
import { loadOpenClawPlugin, persistOpenClawEntry } from '../openclaw-adapter.js'

export default async function pluginRoutes(app: FastifyInstance) {
  // GET /plugins — list all registered plugins
  app.get('/plugins', {
    schema: {
      tags: ['plugins'],
      summary: 'List registered plugins',
      response: {
        200: {
          type: 'object',
          properties: {
            plugins: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:     { type: 'string' },
                  enabled:  { type: 'boolean' },
                  builtin:  { type: 'boolean' },
                  openclaw: { type: 'boolean' },
                  hooks:    { type: 'array', items: { type: 'string' } },
                  error:    { type: ['string', 'null'] },
                  path:     { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  }, async () => ({ plugins: plugins.getAll() }))

  // POST /plugins/:name/enable
  app.post('/plugins/:name/enable', {
    schema: { tags: ['plugins'], summary: 'Enable a plugin' },
  }, async (req, reply) => {
    const { name } = req.params as { name: string }
    try {
      plugins.enable(name)
      return { ok: true }
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message })
    }
  })

  // POST /plugins/:name/disable
  app.post('/plugins/:name/disable', {
    schema: { tags: ['plugins'], summary: 'Disable a plugin' },
  }, async (req, reply) => {
    const { name } = req.params as { name: string }
    try {
      plugins.disable(name)
      return { ok: true }
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message })
    }
  })

  // POST /plugins/install — load an external plugin from a file path
  app.post('/plugins/install', {
    schema: {
      tags: ['plugins'],
      summary: 'Install an external plugin from a file path',
      body: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { path } = req.body as { path: string }
    try {
      const entry = await plugins.loadExternal(path)
      return { ok: true, plugin: entry }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  })

  // POST /plugins/install-openclaw — load an OpenClaw-compatible plugin
  app.post('/plugins/install-openclaw', {
    schema: {
      tags: ['plugins'],
      summary: 'Install an OpenClaw-compatible plugin from a package name or local path',
      body: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { path } = req.body as { path: string }
    try {
      const { plugin, manifest, path: resolvedPath } = await loadOpenClawPlugin(path)
      const entry = plugins.register(plugin, { builtin: false, path: resolvedPath, openclaw: true })
      persistOpenClawEntry(plugin.name, resolvedPath)
      return { ok: true, plugin: entry, manifest }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  })
}
