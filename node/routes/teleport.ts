import type { FastifyInstance, FastifyRequest } from 'fastify'
import { hostname, networkInterfaces } from 'os'
import { createHmac, timingSafeEqual } from 'crypto'
import * as db from '../db.js'
import { parseWindow, listProjectFolders, listConversations, getRawConversation } from '../teleport.js'
import { S } from './schemas.js'

// A peer the daemon may sign/proxy a request to (secure "token" mode only — the
// default LAN flow has the agent scan/pull over Bash, no peer registry needed).
interface Peer { name: string; host: string; port: number; addresses: string[]; version?: string }

// Operator-configured peers (an explicit allowlist for cross-subnet/VPN/secure mode).
function staticPeers(): Peer[] {
  return (db.getSettings().TELEPORT_STATIC_PEERS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(entry => {
      const [h, port] = entry.split(':')
      return { name: h, host: h, port: parseInt(port || process.env.PORT || '47290'), addresses: [h] }
    })
}
function knownPeers(): Peer[] {
  const seen = new Set<string>(); const all: Peer[] = []
  for (const p of staticPeers()) {
    const key = `${p.host}:${p.port}`
    if (!seen.has(key)) { seen.add(key); all.push(p) }
  }
  return all
}

function isLocalReq(req: FastifyRequest): boolean {
  const ip = req.ip
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

// Private/LAN ranges. The token-less path is allowed ONLY from these, so an
// accidentally public-bound daemon never serves conversations to the internet.
function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^127\./.test(v4) || ip === '::1') return true
  if (/^10\./.test(v4)) return true
  if (/^192\.168\./.test(v4)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true
  if (/^169\.254\./.test(v4)) return true            // IPv4 link-local
  if (/^fe80:/i.test(ip)) return true                // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true     // IPv6 ULA (fc00::/7)
  return false
}

// Sign requests instead of transmitting the shared token: x-teleport-sig =
// HMAC(token, method + url + ts). The secret never crosses the wire, and the
// timestamp bounds replay. Peers verify with their own copy of the token.
function sign(token: string, method: string, url: string, ts: string): string {
  return createHmac('sha256', token).update(`${method} ${url} ${ts}`).digest('hex')
}
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')) } catch { return false }
}
const SIG_SKEW_MS = 300_000   // ±5 min replay window

// Map a `host` param to a peer base URL, or null when it's this machine.
// SSRF guard: only ever proxy to a peer ACTUALLY DISCOVERED via mDNS, using the
// address that peer advertised — never an arbitrary caller-supplied host.
function resolvePeer(host?: string): { base: string } | null {
  const me = hostname()
  if (!host || host === 'local' || host === 'localhost' || host === me) return null
  const peer = knownPeers().find(p => p.name === host || p.host === host || p.addresses.includes(host))
  if (!peer) throw Object.assign(new Error(`unknown teleport peer "${host}" (not discovered on the LAN or in TELEPORT_STATIC_PEERS)`), { statusCode: 400 })
  return { base: `http://${peer.host}:${peer.port}` }
}

// Proxy a /teleport/* request to a discovered peer, authenticating with an
// HMAC signature (token is never sent in the clear).
async function proxy(base: string, path: string, query: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v))
  const tok = db.getSettings().TELEPORT_TOKEN
  const headers: Record<string, string> = {}
  if (tok) {
    const ts = String(Date.now())
    headers['x-teleport-ts']  = ts
    headers['x-teleport-sig'] = sign(tok, 'GET', url.pathname + url.search, ts)
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  return res.json()
}

export default async function teleportRoutes(app: FastifyInstance) {
  // Gate non-localhost access: network must be enabled. If a TELEPORT_TOKEN is
  // set, require a fresh valid HMAC signature (token never transmitted). If the
  // token is left blank, auth is DISABLED — open on the LAN to anyone who can
  // reach the port (trusted networks only).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/teleport')) return
    if (req.url.startsWith('/teleport/ping')) return   // unauthenticated identity handshake
    if (isLocalReq(req)) return
    const cfg = db.getSettings()
    if (cfg.TELEPORT_NETWORK_ENABLED !== '1') return reply.code(403).send({ error: 'teleport network access disabled on this host' })
    if (!cfg.TELEPORT_TOKEN) {
      // Token auth disabled — serve unauthenticated ONLY to private/LAN clients,
      // never to a public peer (guards against an accidentally public-bound daemon).
      if (isPrivateIp(req.ip)) return
      return reply.code(401).send({ error: 'unauthenticated teleport is only allowed from a private/LAN address — set a TELEPORT_TOKEN for off-LAN access' })
    }
    const ts  = req.headers['x-teleport-ts']  as string | undefined
    const sig = req.headers['x-teleport-sig'] as string | undefined
    if (!ts || !sig) return reply.code(401).send({ error: 'missing teleport signature' })
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > SIG_SKEW_MS) return reply.code(401).send({ error: 'stale or invalid timestamp' })
    if (!safeEqualHex(sign(cfg.TELEPORT_TOKEN, req.method, req.url, ts), sig)) return reply.code(401).send({ error: 'invalid teleport signature' })
  })

  // ── Identity handshake (ping/pong) ──────────────────────────────────────────
  // Lets the dashboard browser confirm an IP:port is really a restwalker peer.
  // CORS + Private-Network-Access headers so a localhost page may reach a LAN IP.
  function pingCors(reply: import('fastify').FastifyReply) {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Private-Network', 'true')
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
    reply.header('Access-Control-Allow-Headers', '*')
  }
  app.options('/teleport/ping', async (_req, reply) => { pingCors(reply); return reply.code(204).send() })
  app.get('/teleport/ping', {
    schema: { tags: ['teleport'], summary: 'Identity handshake — returns the service id/version (the "pong")' },
  }, async (_req, reply) => {
    pingCors(reply)
    return {
      service: 'restwalker',
      version: process.env.npm_package_version ?? 'dev',
      host: hostname(),
      teleport_network: db.getSettings().TELEPORT_NETWORK_ENABLED === '1',
    }
  })

  // ── Connection handoff ──────────────────────────────────────────────────────
  // Resolve a saved peer + sign the request HERE (token stays on the daemon),
  // and hand back a ready-to-run request. The skill executes the `curl` from its
  // own Bash — the process that actually holds macOS Local-Network permission —
  // so the launchd daemon never makes the LAN connection.
  app.get('/teleport/handoff', {
    schema: {
      tags: ['teleport'],
      summary: 'Get a ready-to-run (signed) request to pull from a peer directly',
      querystring: {
        type: 'object', required: ['host', 'folder'],
        properties: {
          host:    { type: 'string', description: 'Saved peer host/ip (must be known)' },
          kind:    { type: 'string', enum: ['conversation', 'list', 'folders'], description: 'default conversation' },
          folder:  { type: 'string' },
          window:  { type: 'string' },
          session: { type: 'string' },
          full:    { type: 'string', enum: ['0', '1'] },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, 400: S.error },
    },
  }, async (req) => {
    const q = req.query as { host: string; kind?: string; folder: string; window?: string; session?: string; full?: string }
    const peer = resolvePeer(q.host)   // throws 400 if not a known peer
    if (!peer) throw Object.assign(new Error('handoff requires a remote host (this is the local machine)'), { statusCode: 400 })
    const path = q.kind === 'list' ? '/teleport/list' : q.kind === 'folders' ? '/teleport/folders' : '/teleport/conversation'
    const url = new URL(peer.base + path)
    for (const k of ['folder', 'window', 'session', 'full'] as const) {
      const v = q[k]; if (v != null && v !== '') url.searchParams.set(k, String(v))
    }
    const tok = db.getSettings().TELEPORT_TOKEN
    const headers: Record<string, string> = {}
    if (tok) {
      const ts = String(Date.now())
      headers['x-teleport-ts']  = ts
      headers['x-teleport-sig'] = sign(tok, 'GET', url.pathname + url.search, ts)
    }
    const hflags = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ')
    return { url: url.toString(), headers, curl: `curl -s --max-time 10 ${hflags} '${url.toString()}'`.replace(/\s+/g, ' ') }
  })

  // Local network info for browser-side discovery — reading our own interfaces
  // is a LOCAL operation (no LAN connection), so the daemon can do it. The
  // browser then scans the /24 itself (it has Local-Network permission).
  app.get('/teleport/local-net', {
    schema: { tags: ['teleport'], summary: 'This machine\'s private /24 prefixes + self IPs (for browser-side scan)' },
  }, async () => {
    const prefixes = new Set<string>(); const self_ips: string[] = []
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue
        if (!isPrivateIp(a.address)) continue
        self_ips.push(a.address)
        prefixes.add(a.address.split('.').slice(0, 3).join('.'))
      }
    }
    return { prefixes: [...prefixes], self_ips, self_host: hostname() }
  })

  app.get('/teleport/folders', {
    schema: {
      tags: ['teleport'],
      summary: 'List known Claude Code project folders (most-recent first)',
      querystring: { type: 'object', properties: { host: { type: 'string', description: 'Peer host/name; omit for this machine' } } },
      response: { 200: { type: 'object', properties: { host: { type: 'string' }, folders: { type: 'array', items: {
        type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, lastActive: { type: 'string' } } } } } } },
    },
  }, async (req) => {
    const { host } = req.query as { host?: string }
    const peer = resolvePeer(host)
    if (peer) return proxy(peer.base, '/teleport/folders', {})
    return { host: hostname(), folders: listProjectFolders().map(f => ({ path: f.path, name: f.name, lastActive: f.lastActive })) }
  })

  app.get('/teleport/list', {
    schema: {
      tags: ['teleport'],
      summary: 'List conversations in a folder within a time window (metadata only)',
      querystring: {
        type: 'object', required: ['folder'],
        properties: {
          folder: { type: 'string', description: 'Folder name, path, or substring' },
          window: { type: 'string', description: 'e.g. 1h, 6h, 24h (default from settings)' },
          host:   { type: 'string', description: 'Peer host/name; omit for this machine' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const { folder, window, host } = req.query as { folder: string; window?: string; host?: string }
    const peer = resolvePeer(host)
    if (peer) return proxy(peer.base, '/teleport/list', { folder, window })
    const win = parseWindow(window ?? db.getSettings().TELEPORT_DEFAULT_WINDOW)
    return { host: hostname(), conversations: listConversations(folder, win) }
  })

  app.get('/teleport/conversation', {
    schema: {
      tags: ['teleport'],
      summary: 'Get the RAW conversation for a folder/window (most recent, or a specific session)',
      querystring: {
        type: 'object', required: ['folder'],
        properties: {
          folder:  { type: 'string', description: 'Folder name, path, or substring' },
          window:  { type: 'string', description: 'e.g. 1h, 6h, 24h (default from settings)' },
          session: { type: 'string', description: 'Specific session id (else most recent in window)' },
          full:    { type: 'string', enum: ['0', '1'], description: '1 = no per-item truncation' },
          host:    { type: 'string', description: 'Peer host/name; omit for this machine' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const { folder, window, session, full, host } = req.query as
      { folder: string; window?: string; session?: string; full?: string; host?: string }
    const peer = resolvePeer(host)
    if (peer) return proxy(peer.base, '/teleport/conversation', { folder, window, session, full })
    const win = parseWindow(window ?? db.getSettings().TELEPORT_DEFAULT_WINDOW)
    return getRawConversation({ query: folder, windowMs: win, sessionId: session, full: full === '1' })
  })
}
