// Teleport LAN discovery: advertise this restwalker as _restwalker._tcp and
// browse for peers. Only started when TELEPORT_NETWORK_ENABLED=1.

import { Bonjour } from 'bonjour-service'
import { hostname } from 'os'

export interface Peer {
  name:      string
  host:      string       // first reachable address
  port:      number
  addresses: string[]
  version?:  string
}

const SERVICE_TYPE = 'restwalker'   // → _restwalker._tcp

let _bonjour: InstanceType<typeof Bonjour> | null = null
let _browser: ReturnType<InstanceType<typeof Bonjour>['find']> | null = null
let _log = { info: (_: string) => {}, warn: (_: string) => {} }
export function setLogger(l: typeof _log) { _log = l }

export function startMdns(port: number, version: string): void {
  if (_bonjour) return
  try {
    _bonjour = new Bonjour()
    _bonjour.publish({ name: `restwalker@${hostname()}`, type: SERVICE_TYPE, port, txt: { host: hostname(), version } })
    _browser = _bonjour.find({ type: SERVICE_TYPE })
    _browser.on('up',   (s) => _log.info(`[teleport] peer up: ${(s.txt as { host?: string })?.host ?? s.name}`))
    _browser.on('down', (s) => _log.info(`[teleport] peer down: ${(s.txt as { host?: string })?.host ?? s.name}`))
    _log.info(`[teleport] mDNS advertising _${SERVICE_TYPE}._tcp on :${port}`)
  } catch (e) {
    _log.warn('[teleport] mDNS start failed: ' + (e as Error).message)
  }
}

export function stopMdns(): void {
  try { _browser?.stop?.() } catch { /* ignore */ }
  try { _bonjour?.unpublishAll?.(() => _bonjour?.destroy?.()) } catch { /* ignore */ }
  _bonjour = null; _browser = null
}

export function getPeers(): Peer[] {
  if (!_browser) return []
  const me = hostname()
  return (_browser.services ?? [])
    .map((s) => {
      const txt = (s.txt ?? {}) as { host?: string; version?: string }
      return {
        name:      txt.host ?? s.name,
        host:      (s.addresses ?? [])[0] ?? s.host,
        port:      s.port,
        addresses: s.addresses ?? [],
        version:   txt.version,
      }
    })
    .filter(p => p.name !== me)   // exclude self
}
