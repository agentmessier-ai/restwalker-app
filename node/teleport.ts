// Teleport core (local): resolve a folder name -> Claude Code project dir, find
// sessions in a time window, and return the RAW conversation (messages + tool
// calls). Cross-machine routing/security live in routes/teleport.ts; this file
// only ever reads the local ~/.claude/projects tree.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { hostname } from 'os'
import { CLAUDE_PROJECTS_DIR } from './db.js'
import { parseTranscriptLine } from './transcript.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectFolder {
  path:        string   // real cwd, read from the session files
  encodedDir:  string   // the ~/.claude/projects/<encoded> dir name
  name:        string   // basename of path
  lastActive:  string   // ISO, newest session mtime
}

export interface ConversationCandidate {
  host:               string
  session_id:         string
  project_path:       string
  git_branch:         string | null
  started_at:         string | null
  ended_at:           string | null
  message_count:      number
  first_user_request: string
}

export interface RawTurn {
  role:        'user' | 'assistant'
  ts:          string | null
  text:        string
  tool_uses?:  { name: string; input: unknown }[]
  tool_results?: { is_error: boolean; content: string }[]
}

export interface RawConversation {
  source:    { host: string; project_path: string; session_id: string; git_branch: string | null }
  window:    { since: string; until: string }
  turns:     RawTurn[]
  turn_count: number
  truncated: boolean
}

// ── Window parsing ───────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 6 * 3600_000   // 6h

export function parseWindow(s?: string): number {
  if (!s) return DEFAULT_WINDOW_MS
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i)
  if (!m) return DEFAULT_WINDOW_MS
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86_400_000
  return Math.max(60_000, n * mult)
}

// ── Project folder discovery ─────────────────────────────────────────────────

const PER_RESULT_CAP = 1500          // chars per tool result/input before truncation
const TOTAL_CAP      = 150_000       // chars total before we start dropping oldest turns

// Read the real cwd out of a session dir by scanning a file for the first line
// that carries one (queue-operation/last-prompt lines don't).
function cwdFromDir(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const { f } of files.slice(0, 2)) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n')
      for (const line of lines) {
        if (!line) continue
        try { const d = JSON.parse(line); if (typeof d.cwd === 'string' && d.cwd) return d.cwd } catch { /* skip */ }
      }
    }
  } catch { /* unreadable */ }
  return null
}

let _folderCache: { at: number; folders: ProjectFolder[] } | null = null

export function listProjectFolders(): ProjectFolder[] {
  if (_folderCache && Date.now() - _folderCache.at < 30_000) return _folderCache.folders
  const folders: ProjectFolder[] = []
  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const enc of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const dir = join(CLAUDE_PROJECTS_DIR, enc)
      let st; try { st = statSync(dir) } catch { continue }
      if (!st.isDirectory()) continue
      const path = cwdFromDir(dir)
      if (!path) continue
      const sessions = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      const lastM = sessions.reduce((mx, f) => Math.max(mx, statSync(join(dir, f)).mtimeMs), 0)
      folders.push({ path, encodedDir: enc, name: basename(path), lastActive: new Date(lastM).toISOString() })
    }
  }
  folders.sort((a, b) => b.lastActive.localeCompare(a.lastActive))
  _folderCache = { at: Date.now(), folders }
  return folders
}

// Match a query against known folders: exact path, then basename, then substring.
export function resolveFolders(query: string): ProjectFolder[] {
  const q = query.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~')
  const all = listProjectFolders()
  const exact = all.filter(f => f.path === q)
  if (exact.length) return exact
  const byName = all.filter(f => f.name.toLowerCase() === q.toLowerCase())
  if (byName.length) return byName
  const ql = q.toLowerCase()
  return all.filter(f => f.path.toLowerCase().includes(ql) || f.name.toLowerCase().includes(ql))
}

// ── Session listing within a window ──────────────────────────────────────────

function sessionFilesInWindow(encodedDir: string, sinceMs: number): { sessionId: string; file: string; mtime: number }[] {
  const dir = join(CLAUDE_PROJECTS_DIR, encodedDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ sessionId: basename(f, '.jsonl'), file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter(s => s.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime)
}

export function listConversations(query: string, windowMs: number): ConversationCandidate[] {
  const since = Date.now() - windowMs
  const out: ConversationCandidate[] = []
  for (const folder of resolveFolders(query)) {
    for (const s of sessionFilesInWindow(folder.encodedDir, since)) {
      try {
        const lines = readFileSync(s.file, 'utf8').split('\n')
        let firstReq = '', startTs: string | null = null, endTs: string | null = null, branch: string | null = null, count = 0
        for (const line of lines) {
          const e = parseTranscriptLine(line)
          if (!e) continue
          if (e.ts && new Date(e.ts).getTime() < since) continue   // window-filter by message ts
          count++
          if (e.ts) { startTs = startTs ?? e.ts; endTs = e.ts }
          if (e.gitBranch) branch = e.gitBranch
          if (e.type === 'user' && !firstReq && e.text.trim()) firstReq = e.text.trim().slice(0, 200)
        }
        if (count > 0) out.push({
          host: hostname(), session_id: s.sessionId, project_path: folder.path,
          git_branch: branch, started_at: startTs, ended_at: endTs,
          message_count: count, first_user_request: firstReq,
        })
      } catch { /* skip unreadable */ }
    }
  }
  return out.sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''))
}

// ── Raw conversation extraction ──────────────────────────────────────────────

export function getRawConversation(opts: {
  query: string
  windowMs: number
  sessionId?: string
  full?: boolean
}): RawConversation | { error: string; candidates?: ConversationCandidate[] } {
  const { query, windowMs, sessionId, full } = opts
  const since = Date.now() - windowMs
  const folders = resolveFolders(query)
  if (!folders.length) return { error: `no Claude project folder matches "${query}"` }

  // Pick the session: explicit id, else the most recent across matched folders.
  let target: { folder: ProjectFolder; file: string; sessionId: string } | null = null
  const ranked: { folder: ProjectFolder; file: string; sessionId: string; mtime: number }[] = []
  for (const folder of folders) {
    for (const s of sessionFilesInWindow(folder.encodedDir, since)) {
      if (sessionId && s.sessionId !== sessionId) continue
      ranked.push({ folder, file: s.file, sessionId: s.sessionId, mtime: s.mtime })
    }
  }
  ranked.sort((a, b) => b.mtime - a.mtime)
  target = ranked[0] ?? null
  if (!target) {
    // ambiguity/help: hand back candidates so the agent can choose
    return { error: sessionId ? `session ${sessionId} not found in window` : `no sessions in the last window for "${query}"`,
             candidates: listConversations(query, windowMs) }
  }

  const lines = readFileSync(target.file, 'utf8').split('\n')
  const trunc = (s: string) => (full || s.length <= PER_RESULT_CAP) ? s : s.slice(0, PER_RESULT_CAP) + `…[+${s.length - PER_RESULT_CAP} chars]`

  const turns: RawTurn[] = []
  let branch: string | null = null, firstTs: string | null = null, lastTs: string | null = null
  for (const line of lines) {
    const e = parseTranscriptLine(line)
    if (!e) continue
    if (e.ts && new Date(e.ts).getTime() < since) continue
    if (e.gitBranch) branch = e.gitBranch
    if (e.ts) { firstTs = firstTs ?? e.ts; lastTs = e.ts }

    if (e.type === 'assistant') {
      const turn: RawTurn = { role: 'assistant', ts: e.ts, text: e.text }
      if (e.toolUses.length) turn.tool_uses = e.toolUses.map(u => ({ name: u.name, input: full ? u.input : undefined }))
      if (turn.text || turn.tool_uses) turns.push(turn)
    } else {
      const turn: RawTurn = { role: 'user', ts: e.ts, text: e.text }
      if (e.toolResults.length) turn.tool_results = e.toolResults.map(r => ({
        is_error: r.is_error,
        content: trunc(typeof r.content === 'string' ? r.content : JSON.stringify(r.content)),
      }))
      if (turn.text || turn.tool_results) turns.push(turn)
    }
  }

  // Total size cap: drop oldest turns until under TOTAL_CAP (unless full).
  let truncated = false
  if (!full) {
    let total = turns.reduce((n, t) => n + t.text.length + JSON.stringify(t.tool_results ?? '').length, 0)
    while (total > TOTAL_CAP && turns.length > 1) {
      const dropped = turns.shift()!
      total -= dropped.text.length + JSON.stringify(dropped.tool_results ?? '').length
      truncated = true
    }
  }

  return {
    source: { host: hostname(), project_path: target.folder.path, session_id: target.sessionId, git_branch: branch },
    window: { since: new Date(since).toISOString(), until: new Date().toISOString() },
    turns, turn_count: turns.length, truncated,
  }
}
