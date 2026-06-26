const MAP: Record<string, string> = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.md':   'text/markdown',
  '.json': 'application/json',
  '.txt':  'text/plain',
  '.sh':   'text/x-shellscript',
  '.ts':   'text/x-typescript',
  '.js':   'text/javascript',
  '.py':   'text/x-python',
  '.csv':  'text/csv',
  '.yaml': 'text/yaml',
  '.yml':  'text/yaml',
  '.toml': 'text/x-toml',
  '.xml':  'text/xml',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf':  'application/pdf',
}

export function lookup(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MAP[ext] ?? 'text/plain'
}
