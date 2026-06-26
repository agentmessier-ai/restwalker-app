import type { FastifyInstance, FastifyRequest } from 'fastify'
import { hostname } from 'os'
import * as db from '../db.js'
import { parseWindow, listProjectFolders, listConversations, getRawConversation } from '../teleport.js'
import { getPeers } from '../teleport-mdns.js'
import { S } from './schemas.js'

function isLocalReq(req: FastifyRequest): boolean {
  const ip = req.ip
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

// Map a `host` param to a peer base URL, or null when it's this machine.
function resolvePeer(host?: string): { base: string } | null {
  const me = hostname()
  if (!host || host === 'local' || host === 'localhost' || host === me) return null
  const peer = getPeers().find(p => p.name === host || p.host === host || p.addresses.includes(host))
  if (peer) return { base: `http://${peer.host}:${peer.port}` }
  const [h, port] = host.split(':')                  // allow explicit host[:port]
  return { base: `http://${h}:${port || process.env.PORT || '47290'}` }
}

// Proxy a /teleport/* request to a peer, presenting our shared token.
async function proxy(base: string, path: string, query: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v))
  const tok = db.getSettings().TELEPORT_TOKEN
  const res = await fetch(url, {
    headers: tok ? { 'x-teleport-token': tok } : {},
    signal: AbortSignal.timeout(8000),
  })
  return res.json()
}

export default async function teleportRoutes(app: FastifyInstance) {
  // Gate non-localhost access: requires network enabled + matching token.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/teleport')) return
    if (isLocalReq(req)) return
    const cfg = db.getSettings()
    if (cfg.TELEPORT_NETWORK_ENABLED !== '1') return reply.code(403).send({ error: 'teleport network access disabled on this host' })
    const tok = req.headers['x-teleport-token']
    if (!cfg.TELEPORT_TOKEN || tok !== cfg.TELEPORT_TOKEN) return reply.code(401).send({ error: 'invalid or missing teleport token' })
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

  app.get('/teleport/peers', {
    schema: {
      tags: ['teleport'],
      summary: 'Discovered restwalker peers on the LAN (mDNS)',
      response: { 200: { type: 'object', properties: {
        enabled: { type: 'boolean' },
        peers: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, host: { type: 'string' }, port: { type: 'integer' }, version: { type: 'string' } } } } } } },
    },
  }, async () => ({ enabled: db.getSettings().TELEPORT_NETWORK_ENABLED === '1', peers: getPeers() }))
}
