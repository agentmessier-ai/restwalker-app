import type { FastifyInstance } from 'fastify'
import * as db from '../db.js'
import { S, S_PROMPT } from './schemas.js'

export default async function systemPromptRoutes(app: FastifyInstance) {
  app.get('/system-prompt', {
    schema: { tags: ['system-prompt'], summary: 'Get the active system prompt and all versions' },
  }, async () => {
    return {
      active:   db.getActiveSystemPrompt(),
      builtin:  db.getBuiltinSystemPrompt(),
      versions: db.getSystemPromptVersions(),
    }
  })

  app.post('/system-prompt', {
    schema: {
      tags: ['system-prompt'],
      summary: 'Save a new system prompt version (becomes active immediately)',
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1 },
          label:   { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, prompt: S_PROMPT } } },
    },
  }, async (req) => {
    const { content, label } = req.body as { content: string; label?: string }
    const prompt = db.saveSystemPromptVersion(content.trim(), label?.trim())
    return { ok: true, prompt }
  })

  app.post('/system-prompt/restore-builtin', {
    schema: {
      tags: ['system-prompt'],
      summary: 'Restore the built-in default by saving it as a new version',
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, prompt: S_PROMPT } } },
    },
  }, async () => {
    const builtin = db.getBuiltinSystemPrompt()
    const prompt = db.saveSystemPromptVersion(builtin.content, 'Restored from built-in default')
    return { ok: true, prompt }
  })

  app.delete('/system-prompt/:id', {
    schema: {
      tags: ['system-prompt'],
      summary: 'Delete a user-created system prompt version (not the builtin)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: S.ok, 400: S.error, 404: S.error },
    },
  }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id)
    const sp = db.getSystemPromptById(id)
    if (!sp) return reply.code(404).send({ error: 'not found' })
    if (sp.is_builtin) return reply.code(400).send({ error: 'cannot delete the built-in system prompt' })
    db.deleteSystemPromptVersion(id)
    return { ok: true }
  })
}
