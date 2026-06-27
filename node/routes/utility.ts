import type { FastifyInstance } from 'fastify'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import * as db from '../db.js'
import { S } from './schemas.js'

// Derive the skill's directory name: prefer the frontmatter `name:`, else the
// filename minus the -skill.md suffix. Kebab-case, filesystem-safe.
function skillName(filePath: string, content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  const nameLine = fm?.[1].match(/^\s*name:\s*(.+?)\s*$/m)
  const raw = nameLine?.[1] ?? basename(filePath).replace(/-skill\.md$/i, '').replace(/\.md$/i, '')
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

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

  // Deploy a generated *-skill.md artifact into Claude Code as skills/<name>/SKILL.md,
  // either at user level (~/.claude) or inside a project (<project>/.claude).
  app.post('/skills/deploy', {
    schema: {
      tags: ['utility'],
      summary: 'Deploy a generated skill file into Claude Code (user or project level)',
      body: {
        type: 'object',
        required: ['path', 'scope'],
        properties: {
          path:        { type: 'string', description: 'Absolute path to the generated *-skill.md file' },
          scope:       { type: 'string', enum: ['user', 'project'] },
          projectPath: { type: 'string', description: 'Required when scope = project' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, deployed: { type: 'string' }, name: { type: 'string' } } },
        400: S.error,
      },
    },
  }, async (req, reply) => {
    const { path: src, scope, projectPath } = req.body as { path: string; scope: 'user' | 'project'; projectPath?: string }
    if (!existsSync(src)) return reply.code(400).send({ error: `file not found: ${src}` })
    if (scope === 'project' && !projectPath?.trim()) return reply.code(400).send({ error: 'projectPath required for project scope' })

    let content: string
    try { content = readFileSync(src, 'utf8') } catch (e) { return reply.code(400).send({ error: (e as Error).message }) }

    const name = skillName(src, content)
    const baseDir = scope === 'user'
      ? join(homedir(), '.claude', 'skills', name)
      : join(projectPath!.trim(), '.claude', 'skills', name)
    try {
      mkdirSync(baseDir, { recursive: true })
      const dest = join(baseDir, 'SKILL.md')
      writeFileSync(dest, content, 'utf8')
      app.log.info(`[skills] deployed ${name} → ${dest}`)
      return { ok: true, deployed: dest, name }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  })
}
