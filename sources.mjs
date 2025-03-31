import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

export function getPM2(pattern) {
  const env = { ...process.env }

  let p = process.cwd()
  while (p) {
    const pm2 = path.join(p, 'node_modules', '.bin', 'pm2')
    if (fs.existsSync(pm2)) {
      env.PATH = [path.dirname(pm2), env.PATH].filter(Boolean).join(path.delimiter)
      break
    }
    const prev = p
    p = path.dirname(p)
    if (prev === p) {
      break
    }
  }

  let jlist
  try {
    jlist = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env,
    })
  } catch (err) {
    if (err.code === 'ENOENT') {
      return []
    }
    throw err
  }
  const start = jlist.indexOf('[')
  const end = jlist.lastIndexOf(']')
  const processes = JSON.parse(jlist.slice(start, end + 1))

  return processes
    .filter(({ name }) => !pattern || name.includes(pattern))
    .map(({ name }) => ({
      name,
      read(opts) {
        const proc = spawn('pm2', ['logs', '--raw', '--lines', opts.tail ?? '1000', !opts.follow && '--nostream', name].filter(Boolean), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        return [
          Object.assign(proc.stdout, { label: `${name}:stdout` }),
          Object.assign(proc.stderr, { label: `${name}:stderr` }),
        ]
      },
    }))
}

export function getDocker(pattern) {
  return execFileSync('docker', ['ps', '--format', 'json'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(({ Names: name }) => !pattern || name.includes(pattern))
    .map(({ ID: id, Names: name, Image: image, RunningFor: runningFor }) => ({
      name: `${(name.match(/^[\w-]+(\.\d+)?/)?.[0] ?? name)?.padEnd(
        26,
        ' '
      )} \u001b[2m${image} (${runningFor})\u001b[22m`,
      short: id,
      value: id,
      read(opts) {
        // TODO: opts
        const dockerLogsProc = spawn(
          'docker',
          [
            'logs',
            opts.follow && '--follow',
            opts.since && ['--since', opts.since],
            opts.tail && ['--tail', opts.tail],
            id,
          ]
            .filter(Boolean)
            .flat(),
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        return [
          Object.assign(dockerLogsProc.stdout, { label: `${id}:stdout` }),
          Object.assign(dockerLogsProc.stderr, { label: `${id}:stderr` }),
        ]
      },
    }))
}

export function getDockerServices(pattern) {
  return execFileSync('docker', ['service', 'ls', '--format', 'json'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(({ Name: name }) => !pattern || name.includes(pattern))
    .map(({ Name: name, Image: image, Replicas: replicas }) => ({
      name: `${name} \u001b[2m${image} (${replicas})\u001b[22m`,
      value: name,
      read(opts) {
        const proc = spawn(
          'docker',
          [
            'service',
            'logs',
            '--raw',
            opts.follow && '--follow',
            opts.since && ['--since', opts.since],
            opts.tail && ['--tail', opts.tail],
            name,
          ]
            .filter(Boolean)
            .flat(),
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        return [
          Object.assign(proc.stdout, { label: `${name}:stdout` }),
          Object.assign(proc.stderr, { label: `${name}:stderr` }),
        ]
      },
    }))
}

export function getFile(path) {
  if (!path || !fs.existsSync(path) || !fs.statSync(path).isFile()) {
    return []
  }

  return [
    {
      name: path,
      read() {
        const stream = fs.createReadStream(path)
        stream.label = path
        return [stream]
      },
    },
  ]
}

export function getStdin(pattern) {
  if (pattern !== '-') {
    return []
  }

  return [
    {
      name: 'stdin',
      read() {
        return [Object.assign(process.stdin, { label: 'stdin' })]
      },
    },
  ]
}
