#!/usr/bin/env node
import { pipeline } from 'node:stream/promises'
import split from 'split2'
import fs from 'node:fs'
import path from 'node:path'
import tp from 'node:timers/promises'
import tty from 'node:tty'
import React from 'react'
import { formatLevel, formatObject, formatTime } from './format.mjs'
import { render, Text, Box, useApp, useInput, measureElement } from 'ink'
import fp from 'lodash/fp.js'
import TextInput from 'ink-text-input'
import { execFileSync, spawn } from 'node:child_process'
import inquirer from 'inquirer'
import { parseArgs } from 'node:util'

const prompt = async (question) => (await inquirer.prompt([{ ...question, name: 'answer' }])).answer

const { values: opts, positionals: argv } = parseArgs({
  options: {
    from: {
      type: 'string',
      short: 'f',
    },
    tail: {
      type: 'string',
      short: 't',
    },
    sort: {
      type: 'boolean',
      short: 's',
    },
  },
  allowPositionals: true,
  strict: true,
})

let inputs

if (!opts.from && !argv.length && process.stdin.isTTY) {
  opts.from = await prompt({
    type: 'list',
    message: 'From?',
    choices: ['pm2', 'docker', 'docker-service', 'file'],
  })
}

if (opts.from === 'pm2') {
  const env = { ...process.env }

  let p = process.cwd()
  while (p) {
    const pm2 = path.join(p, 'node_modules', '.bin', 'pm2')
    if (fs.existsSync(pm2)) {
      env.PATH = [path.dirname(pm2), env.PATH].filter(Boolean).join(path.delimiter)
      break
    }
    p = path.dirname(p)
  }

  let procs = argv
  if (!procs.length) {
    const processes = JSON.parse(
      execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env })
    )

    procs = await prompt({
      type: 'checkbox',
      message: 'What processes?',
      choices: processes.map(({ name }) => name),
    })
  }

  inputs = procs.flatMap((name) => {
    const proc = spawn('pm2', ['logs', '--raw', '--lines', opts.tail ?? '1000', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    return [
      Object.assign(proc.stdout, { label: name }),
      Object.assign(proc.stderr, { label: `${name}:stderr` }),
    ]
  })
} else if (opts.from === 'docker') {
  let selected = argv
  if (!selected.length) {
    const containers = execFileSync(
      'docker',
      ['ps', '--format', '{{.ID}}\\t{{.Image}}\\t{{.Names}}'],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .sort((a, b) => a[2].localeCompare(b[2]))

    selected = await prompt({
      type: 'checkbox',
      message: 'What container?',
      choices: containers.map(([id, image, name]) => ({
        name: `${name.match(/^[\w-]+\.\d+/) || name} ${image}`,
        short: id,
        value: id,
      })),
    })
  }

  if (selected.length > 1) {
    opts.sort ??= true
  }

  inputs = selected.flatMap((container) => {
    const dockerLogsProc = spawn('docker', ['logs', '-f', container], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return [
      Object.assign(dockerLogsProc.stdout, { label: container }),
      Object.assign(dockerLogsProc.stderr, { label: `${container}:stderr` }),
    ]
  })
} else if (opts.from === 'docker-service') {
  opts.sort ??= true
  const services = argv.length
    ? argv
    : await (async () => {
        const services = execFileSync(
          'docker',
          ['service', 'ls', '--format', '{{.ID}}\\t{{.Image}}\\t{{.Name}}'],
          { encoding: 'utf8' }
        )
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\t'))
          .sort((a, b) => a[2].localeCompare(b[2]))

        return await prompt({
          type: 'checkbox',
          message: 'What service?',
          choices: services.map(([id, image, name]) => ({
            name: `${name.match(/^[\w-]+\.\d+/) || name} ${image}`,
            short: id,
            value: id,
          })),
        })
      })()

  inputs = services.flatMap((service) => {
    const proc = spawn('docker', ['service', 'logs', '--raw', '--follow', service], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return [
      Object.assign(proc.stdout, { label: `${service}:stdout` }),
      Object.assign(proc.stderr, { label: `${service}:stderr` }),
    ]
  })
} else if (argv.length) {
  inputs = argv.map((path) => {
    const stream = fs.createReadStream(path)
    stream.label = path
    return stream
  })
} else {
  inputs = [Object.assign(process.stdin, { label: 'stdin' })]
}

function levelProps(level) {
  if (level >= 60) {
    return { color: 'red' }
  } else if (level >= 50) {
    return { color: 'red' }
  } else if (level >= 40) {
    return { color: 'yellow' }
  } else if (level >= 30) {
    return { color: 'green' }
  } else if (level >= 20) {
    return { color: 'blue' }
  } else {
    return {}
  }
}

const filterTrace = (x) => x.level >= 10
filterTrace.label = 'LEVEL>=TRACE'
const filterDebug = (x) => x.level >= 20
filterDebug.label = 'LEVEL>=DEBUG'
const filterInfo = (x) => x.level >= 30
filterInfo.label = 'LEVEL>=INFO'
const filterWarning = (x) => x.level >= 40
filterWarning.label = 'LEVEL>=WARNING'
const filterError = (x) => x.level >= 50
filterError.label = 'LEVEL>=ERROR'
const filterFatal = (x) => x.level >= 60
filterFatal.label = 'LEVEL>=FATAL'

const ttyfd = fs.openSync('/dev/tty', 'r')
const input = tty.ReadStream(ttyfd)
input.setRawMode(true).setEncoding('utf8')

function Main(props) {
  const {
    rows,
    columns,
    scanPosition,
    scan,
    status,
    messages,
    matching,
    filters,
    rescan: rescan2,
  } = props

  const { exit } = useApp()
  const [position, setPosition] = React.useState(0) // undefined = last, null = scanPosition
  const [fields, setFields] = React.useState(['time', 'level', 'name', 'msg'])
  const [selectedField, setSelectedField] = React.useState(3)
  const [inspect, setInspect] = React.useState()
  const [selected, setSelected] = React.useState([])
  const [prompt, setPrompt] = React.useState(null)
  const [query, setQuery] = React.useState('')

  const ref = React.useRef()
  const [numLines, setNumLines] = React.useState(0)
  React.useEffect(() => {
    const { height } = measureElement(ref.current)
    setNumLines(height - 3) // remove borders + headers
  })

  function rescan() {
    rescan2(new Date(messages[matching.at(position ?? scanPosition)]?.time))
    setPosition(null)
  }

  const pos = (position === null ? scanPosition : position) ?? matching.length - 1

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) {
        setPrompt(null)
      }
      return
    }

    if (inspect) {
      if (key.escape || key.return) {
        setInspect(false)
      }
      return
    }

    // upArrow downArrow leftArrow rightArrow pageDown pageUp return escape ctrl shift tab backspace delete meta
    if (key.upArrow) {
      setPosition(Math.max(pos - 1, 0))
    } else if (key.downArrow) {
      setPosition(Math.min(pos + 1, matching.length - 1))
    } else if (key.pageUp) {
      setPosition(Math.max(pos - numLines, 0))
    } else if (key.pageDown) {
      setPosition(Math.min(pos + numLines, matching.length - 1))
    } else if (key.leftArrow) {
      setSelectedField(Math.max(selectedField - 1, 0))
    } else if (key.rightArrow) {
      setSelectedField(Math.min(selectedField + 1, fields.length - 1))
    } else if (key.return) {
      setInspect(!inspect)
    } else if (key.delete) {
      filters.length = 1
      filters[0] = () => true
      rescan()
    }

    switch (input) {
      case ' ':
        setSelected((selected) => {
          const item = matching[pos]
          const idx = selected.indexOf(item)
          if (idx === -1) {
            return [...selected, item].sort((a, b) => a - b)
          } else {
            return [...selected.slice(0, idx), ...selected.slice(idx + 1)]
          }
        })
        break
      case 'm': {
        const next = matching.findIndex((x, idx) => idx > pos && selected.includes(x))
        setPosition(next !== -1 ? next : undefined)
        break
      }
      case 'M': {
        const next = matching.slice(0, pos).findLastIndex((x) => selected.includes(x))
        setPosition(next !== -1 ? next : 0)
        break
      }
      case 's': {
        messages.sort((a, b) => new Date(a.time) - new Date(b.time))
        rescan()
        break
      }
      case '*': {
        setPrompt({
          label: 'Add Field',
          onSubmit: (field) => {
            if (field) {
              setFields([...fields, field])
            }
          },
        })
        break
      }
      case '/': {
        setPrompt({
          label: 'Filter',
          onSubmit: (query) => {
            const filterFn = (msg) => JSON.stringify(msg).includes(query)
            filterFn.label = `/${query}`
            filters.push(filterFn)
            rescan()
          },
        })
        break
      }
      case '1':
        filters[0] = filterTrace
        rescan()
        break
      case '2':
        filters[0] = filterDebug
        rescan()
        break
      case '3':
        filters[0] = filterInfo
        rescan()
        break
      case '4':
        filters[0] = filterWarning
        rescan()
        break
      case '5':
        filters[0] = filterError
        rescan()
        break
      case '6':
        filters[0] = filterFatal
        rescan()
        break
      case '-': {
        const { msg } = messages[matching.at(pos)] || {}
        if (msg) {
          const fn = (x) => x.msg !== msg
          fn.label = `msg != "${msg}"`
          filters.push(fn)
          rescan()
        }
        break
      }
      case '+': {
        const field = fields[selectedField]
        const value = fp.get(field, messages[matching.at(pos)])
        const fn = (x) => fp.isEqual(fp.get(field, x), value)
        fn.label = `${field} == ${JSON.stringify(value) ?? 'undefined'}`
        filters.push(fn)
        rescan()
        break
      }
      case 'c': {
        messages.length = 0
        rescan()
        break
      }
      case 'g': {
        setPosition(0)
        break
      }
      case 'F': {
        setPosition(undefined)
        break
      }
      case 'G': {
        setPosition(matching.length - 1)
        break
      }
      case 'q': {
        exit()
      }
    }
  })

  const data = []

  const start = Math.max(pos - Math.floor(numLines / 2), 0)
  for (let linePos = start; linePos < start + numLines; ++linePos) {
    if (linePos >= matching.length) {
      continue
    }
    const msg = messages[matching.at(linePos)] || {}
    data.push(
      fields.map((field) => {
        const value = fp.get(field, msg)
        if (field === 'time') {
          return formatTime(value)
        } else if (field === 'level') {
          return formatLevel(value)
        } else if (typeof value === 'string') {
          return value
        } else {
          return JSON.stringify(value) ?? ' '
        }
      })
    )
  }

  const widths = Array.from({ length: data.at(0)?.length ?? 0 }, (_, col) =>
    data.reduce((max, line) => Math.max(max, line[col].length ?? 0), 0)
  )

  let lineIndex = 0
  const lines = []
  for (let linePos = start; linePos < start + numLines; ++linePos) {
    if (linePos >= matching.length) {
      if (linePos === matching.length) {
        lines.push(
          <Text color='blue' dimColor>
            [{status}]
          </Text>
        )
      }
      continue
    }
    const cols = data.at(lineIndex++)
    lines.push(
      <Box key={matching.at(linePos)} flexWrap='nowrap' gap='1'>
        {cols.map((col, idx) => (
          <Box key={idx} width={widths[idx]} flexShrink={idx <= 3 ? 0 : 1}>
            <Text
              wrap='truncate'
              dimColor={linePos !== pos}
              color={selected.includes(matching.at(linePos)) ? 'blue' : null}
              inverse={linePos === pos && selectedField === idx}
              {...(fields[idx] === 'level'
                ? levelProps(messages[matching.at(linePos)]?.level)
                : {})}
            >
              {col}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  const rest = messages[matching.at(pos)] ?? {}

  return (
    <Box flexDirection='column' height={rows} width={columns}>
      <Box gap='1' flexWrap='nowrap'>
        <Text wrap='truncate-middle'>Line: {matching.at(pos)}</Text>
        <Text>Matching: {matching.length}</Text>
        {scan !== messages.length ? (
          <Text>Scanned: {Number((scan / messages.length) * 100).toFixed(1)}%</Text>
        ) : null}
        <Text>Total: {messages.length}</Text>
        <Text>Mem: {Math.round(process.memoryUsage().rss / 1e6)} MB</Text>
      </Box>
      <Box
        ref={ref}
        borderStyle='round'
        borderColor={inspect ? '' : 'blue'}
        flexDirection='column'
        flexWrap='nowrap'
        flexBasis={4}
        flexGrow={inspect ? 0 : 2}
      >
        <Box flexWrap='nowrap' gap='1'>
          {fields.map((field, idx) => (
            <Box
              key={idx}
              width={widths[idx]}
              flexShrink={idx <= 3 ? 0 : 1}
              height={1}
              overflowY='hidden'
            >
              <Text wrap='truncate' dimColor>
                {field}
              </Text>
            </Box>
          ))}
        </Box>
        {lines}
      </Box>
      <ScrollBox
        key={matching[pos]}
        focus={inspect}
        borderStyle='round'
        borderColor={inspect ? 'blue' : ''}
        overflow='hidden'
        flexBasis={0}
        flexGrow={1}
      >
        {formatObject(rest, { lineWidth: columns - 4 })}
      </ScrollBox>
      <Text>{filters.map((fn) => fn.label ?? fn.toString()).join(' & ')}</Text>
      {prompt ? (
        <Box>
          <Text>{prompt.label}: </Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              prompt.onSubmit(query)
              setQuery('')
              setPrompt(null)
            }}
          />
        </Box>
      ) : null}
    </Box>
  )
}

function ScrollBox({ focus, children, ...props }) {
  const [boxHeight, setBoxHeight] = React.useState(0)
  const lines = children.split('\n')
  const contentHeight = lines.length
  const [scroll, setScroll] = React.useState(0)

  useInput((_, key) => {
    if (!focus) {
      return
    }
    if (key.upArrow) {
      setScroll((x) => Math.max(x - 1, 0))
    } else if (key.downArrow) {
      setScroll((x) => Math.min(x + 1, Math.max(0, contentHeight - boxHeight)))
    }
  })

  const ref = React.useRef()

  React.useEffect(() => {
    const { height } = measureElement(ref.current)
    setBoxHeight(height)
  })

  return (
    <Box ref={ref} {...props}>
      <Text>{lines.slice(scroll).join('\n')}</Text>
    </Box>
  )
}

function App() {
  const [state, setState] = React.useState({
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    scan: 0,
    scanPosition: 0,
    status: 'starting...',
    messages: [],
    matching: [],
    filters: [],
    completed: 0,
    rescan: () => {},
  })

  React.useEffect(() => {
    const onResize = () => {
      setState((state) => ({
        ...state,
        columns: process.stdout.columns,
        rows: process.stdout.rows,
      }))
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])

  React.useLayoutEffect(() => {
    const ac = new AbortController()

    let sort = opts.sort
    let scan = 0
    let resume = null
    let completed = 0
    let status = 'starting...'
    const messages = []
    const matching = []
    const filters = [() => true]

    let scanPosition
    let scanToDate
    function rescan(date) {
      if (date) {
        scanToDate = date
      }
      scan = matching.length = 0
      scanPosition = undefined
      resume?.()
    }

    async function loop() {
      while (!ac.signal.aborted) {
        const start = Date.now()
        while (scan < messages.length) {
          const message = messages[scan]
          if (filters.every((fn) => fn(message))) {
            if (sort) {
              const idx = fp.sortedIndexBy((idx) => messages[idx].time, scan, matching)
              matching.splice(idx, 0, scan)
            } else {
              matching.push(scan)
            }
            if (scanPosition === undefined && scanToDate && new Date(message.time) >= scanToDate) {
              scanPosition = matching.length - 1
              scanToDate = null
            }
          }
          ++scan
          if (Date.now() - start > 200) {
            break
          }
        }
        setState((state) => ({
          ...state,
          scanPosition,
          scan,
          status,
          messages,
          matching,
          filters,
          completed,
          rescan,
        }))
        if (scan < messages.length) {
          await tp.setTimeout(10)
          continue
        }
        // wait for resume...
        await new Promise((resolve) => {
          resume = resolve
        })
        resume = null
      }
    }

    status = `reading files (${completed}/${inputs.length})`
    loop().catch((err) => console.error('error', err))

    Promise.all(
      inputs.map(async (input, idx) => {
        await pipeline(
          input,
          split(parseLine),
          async (msgs) => {
            for await (const msg of msgs) {
              msg.time ??= 0
              messages.push(inputs.length > 1 ? { ...msg, _from: input.label ?? idx } : msg)
              if (resume) {
                setImmediate(resume)
                resume = null
              }
            }
          },
          { signal: ac.signal }
        ).catch((err) => {
          status = err.message
        })
        completed += 1
        status = `reading files (${completed}/${inputs.length})`
        resume?.()
      })
    ).then(
      () => {
        status = 'end of file'
        resume?.()
      },
      (err) => {
        status = 'error reading input: ' + err.message
        resume?.()
      }
    )

    return () => {
      ac.abort()
      resume?.()
    }
  }, [])

  return <Main {...state} />
}

// const enterAltScreenCommand = '\x1b[?1049h'
// const leaveAltScreenCommand = '\x1b[?1049l'

const { waitUntilExit } = render(
  <App columns={process.stdout.columns} rows={process.stdout.rows} />,
  { stdin: input }
)

await waitUntilExit()

// input.setRawMode(false)
// input.destroy()
// fs.closeSync(ttyfd)
// console.log('all done')
process.exit(0)

function parseLine(row) {
  try {
    if (row) return JSON.parse(row)
  } catch (err) {
    return { msg: row, err, level: 100 }
  }
}
