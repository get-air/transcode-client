import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const port = Number(process.argv[3] ?? 4195)

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const file = resolve(root, `.${pathname}`)
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end()
    return
  }
  let size
  try {
    size = statSync(file).size
  } catch {
    response.writeHead(404).end()
    return
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  const start = match ? Number(match[1]) : 0
  const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return
  }
  const partial = match !== null
  response.writeHead(partial ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': 'application/octet-stream',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(file, { start, end }).pipe(response)
}).listen(port, '127.0.0.1')
