#!/usr/bin/env node
/**
 * restwalker CLI — install, start, and manage the idle-time Claude task runner.
 *
 * Usage:
 *   npx @agentmessier/restwalker install     # install LaunchAgent + register MCP
 *   npx @agentmessier/restwalker uninstall   # remove LaunchAgent
 *   npx @agentmessier/restwalker start       # start the daemon in the foreground
 *   npx @agentmessier/restwalker status      # check if daemon is running
 */

import { execFileSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const cmd = process.argv[2]

function sh(script, args = []) {
  const full = join(ROOT, script)
  if (!existsSync(full)) {
    console.error(`Script not found: ${full}`)
    process.exit(1)
  }
  execFileSync('bash', [full, ...args], { stdio: 'inherit', cwd: ROOT })
}

switch (cmd) {
  case 'install':
    sh('install.sh', process.argv.slice(3))
    break

  case 'uninstall':
    sh('uninstall.sh')
    break

  case 'start': {
    const tsx = join(ROOT, 'node', 'node_modules', '.bin', 'tsx')
    const app = join(ROOT, 'node', 'app.ts')
    if (!existsSync(tsx)) {
      console.error('Dependencies not installed. Run: npx @agentmessier/restwalker install')
      process.exit(1)
    }
    const proc = spawn(process.execPath, [tsx, app], { stdio: 'inherit', cwd: ROOT })
    proc.on('exit', code => process.exit(code ?? 0))
    break
  }

  case 'status': {
    try {
      const res = await fetch('http://localhost:47290/healthz')
      if (res.ok) {
        const data = await res.json()
        console.log('restwalker is running —', JSON.stringify(data))
      } else {
        console.log('restwalker returned', res.status)
        process.exit(1)
      }
    } catch {
      console.log('restwalker is not running (nothing on port 47290)')
      process.exit(1)
    }
    break
  }

  default:
    console.log(`
restwalker — idle-time Claude task runner

Usage:
  npx @agentmessier/restwalker install     install LaunchAgent + register MCP
  npx @agentmessier/restwalker uninstall   remove LaunchAgent
  npx @agentmessier/restwalker start       run daemon in foreground
  npx @agentmessier/restwalker status      check if daemon is running

Dashboard: http://localhost:47290
`)
}
