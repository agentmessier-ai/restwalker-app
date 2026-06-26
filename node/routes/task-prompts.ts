import type { FastifyInstance } from 'fastify'
import * as db from '../db.js'
import { enqueueTask, forceRunTask } from '../runner.js'
import { S, S_TASK_PROMPT } from './schemas.js'

export default async function taskPromptsRoutes(app: FastifyInstance) {
  app.post('/task-prompts', {
    schema: {
      tags: ['task-prompts'],
      summary: 'Create a new task prompt (v1) and optionally enqueue immediately',
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content:     { type: 'string', minLength: 1 },
          title:       { type: 'string' },
          cwd:         { type: 'string' },
          model:       { type: 'string' },
          provider_id: { type: 'integer' },
          schedule:    { type: 'string', enum: ['once','hourly','daily','weekly','monthly'] },
          run_now:     { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, prompt: S_TASK_PROMPT, task: S.task },
        },
        400: S.error,
      },
    },
  }, async (req, reply) => {
    const { content, title, cwd, model, provider_id, schedule, run_now } =
      req.body as { content?: string; title?: string; cwd?: string; model?: string; provider_id?: number; schedule?: db.TaskSchedule; run_now?: boolean }
    if (!content?.trim()) return reply.code(400).send({ error: 'content required' })
    const prompt = db.createTaskPrompt(content.trim(), {
      title: title?.trim(), cwd: cwd?.trim(), model: model?.trim(),
      providerId: provider_id ?? null, schedule: schedule || 'once',
    })
    const task = db.addTask(prompt.content, prompt.cwd, prompt.model, prompt.provider_id, prompt.schedule as db.TaskSchedule, { promptId: prompt.id })
    enqueueTask(task)
    if (run_now) forceRunTask(task.id, msg => app.log.info(msg)).catch(console.error)
    app.log.info(`[task-prompts] created prompt #${prompt.id} v1, task #${task.id}`)
    return { ok: true, prompt, task }
  })

  app.post('/task-prompts/:id/versions', {
    schema: {
      tags: ['task-prompts'],
      summary: 'Save a new version of an existing task prompt and optionally enqueue',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content:     { type: 'string', minLength: 1 },
          title:       { type: 'string' },
          cwd:         { type: 'string' },
          model:       { type: 'string' },
          provider_id: { type: 'integer' },
          schedule:    { type: 'string', enum: ['once','hourly','daily','weekly','monthly'] },
          run_now:     { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, prompt: S_TASK_PROMPT, task: S.task },
        },
        400: S.error,
        404: S.error,
      },
    },
  }, async (req, reply) => {
    const promptId = parseInt((req.params as { id: string }).id)
    const existing = db.getTaskPrompt(promptId)
    if (!existing) return reply.code(404).send({ error: 'prompt not found' })
    const { content, title, cwd, model, provider_id, schedule, run_now } =
      req.body as { content?: string; title?: string; cwd?: string; model?: string; provider_id?: number; schedule?: db.TaskSchedule; run_now?: boolean }
    if (!content?.trim()) return reply.code(400).send({ error: 'content required' })
    const prompt = db.saveTaskPromptVersion(existing.origin_id, content.trim(), {
      title: title?.trim(), cwd: cwd?.trim(), model: model?.trim(),
      providerId: provider_id ?? null, schedule: schedule || 'once',
    })
    const task = db.addTask(prompt.content, prompt.cwd, prompt.model, prompt.provider_id, prompt.schedule as db.TaskSchedule, { promptId: prompt.id })
    enqueueTask(task)
    if (run_now) forceRunTask(task.id, msg => app.log.info(msg)).catch(console.error)
    app.log.info(`[task-prompts] saved prompt #${existing.origin_id} v${prompt.version}, task #${task.id}`)
    return { ok: true, prompt, task }
  })

  app.get('/task-prompts/:id/versions', {
    schema: {
      tags: ['task-prompts'],
      summary: 'Get all versions of a task prompt chain',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: {
        200: { type: 'object', properties: { versions: { type: 'array', items: S_TASK_PROMPT } } },
        404: S.error,
      },
    },
  }, async (req, reply) => {
    const promptId = parseInt((req.params as { id: string }).id)
    const existing = db.getTaskPrompt(promptId)
    if (!existing) return reply.code(404).send({ error: 'prompt not found' })
    return { versions: db.getTaskPromptVersions(existing.origin_id) }
  })
}
