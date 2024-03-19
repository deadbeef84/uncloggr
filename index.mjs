#!/usr/bin/env node
import { pipeline } from 'node:stream/promises'
import split from 'split2'
import fs from 'node:fs'
import tp from 'node:timers/promises'
import tty from 'node:tty'
import React from 'react'
import { formatLevel, formatObject, formatTime } from './format.mjs'
import { render, Text, Box, useApp, useInput, measureElement } from 'ink'
import fp from 'lodash/fp.js'
import TextInput from 'ink-text-input'
import { execFileSync, spawn } from 'node:child_process'
import inquirer from 'inquirer'

const prompt = async (question) => (await inquirer.prompt([{ ...question, name: 'answer' }])).answer

const inputs = process.argv.length > 2 ? process.argv.slice(1).map(path => fs.createReadStream(path)) : [process.stdin] // dockerLogsProc.stdout, dockerLogsProc.stderr

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
  const { rows, columns, scanPosition, scan, status, messages, matching, filters, rescan: rescan2 } = props

  const [position, setPosition] = React.useState(0)
  const [inspect, setInspect] = React.useState()
  const [selected, setSelected] = React.useState([])
  const [prompt, setPrompt] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const pos = position ?? scanPosition ?? (matching.length - 1)

  const ref = React.useRef()
  const [numLines, setNumLines] = React.useState(0)
  React.useEffect(() => {
    const { height } = measureElement(ref.current)
    setNumLines(height - 3) // remove borders + headers
  })

  function rescan() {
    rescan2(new Date(messages[matching.at(position ?? scanPosition)]?.time))
    setPosition(undefined)
  }

  const { exit } = useApp()

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) {
        setPrompt(false)
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
    } else if (key.return) {
      setInspect(!inspect)
    } else if (key.delete) {
      filters.length = 1
      filters[0] = () => true
      rescan()
    }

    switch (input) {
      case ' ':
        setSelected(selected => {
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
      case '/': {
        setPrompt(true)
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
        const { msg } = messages[matching.at(pos)] || {}
        if (msg) {
          const fn = (x) => x.msg === msg
          fn.label = `msg == "${msg}"`
          filters.push(fn)
          rescan()
        }
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

  const fields = ['err.message']
  const data = []

  const start = Math.max(pos - Math.floor(numLines / 2), -1)
  for (let linePos = start; linePos < start + numLines; ++linePos) {
    if (linePos < 0 || linePos >= matching.length) {
      continue
    }
    const { time, level, msg = '', name, pid, hostname, ...rest } = messages[matching.at(linePos)] || {}
    data.push([
      formatTime(time),
      formatLevel(level),
      name ?? '-',
      msg,
      ...fields.map(field => {
        const value = fp.get(field, rest)
        if (typeof value === 'string') {
          return value
        } else {
          return JSON.stringify(value) ?? '-'
        }
      }),
    ])
  }

  const widths = Array.from({ length: data.at(0)?.length ?? 0 }, (_, col) => data.reduce((max, line) => Math.max(max, line[col]?.length ?? 0), 0))
  const remainingColumns = columns - widths.reduce((xs, x) => xs + x, 0) + (widths[3] ?? 0)
  const msgWidth = Math.min(widths[3], Math.max(remainingColumns, Math.round(columns * 0.25)))

  let lineIndex = 0
  const lines = []
  for (let linePos = start; linePos < start + numLines; ++linePos) {
    if (linePos < 0) {
      if (linePos === -1) {
        lines.push(
          <Text color='blue' dimColor>
            [start of file]
          </Text>
        )
      }
      continue
    }
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
    const [time, level, name, msg, ...cols] = data.at(lineIndex++)
    lines.push(
      <Box key={matching.at(linePos)} flexWrap='nowrap' gap='1'>
        <Box width={widths[0]} flexShrink={0}>
          <Text wrap='truncate' dimColor>
            {time}
          </Text>
        </Box>
        <Box width={widths[1]} flexShrink={0}>
          <Text wrap='truncate' {...levelProps(messages[matching.at(linePos)]?.level)}>
            {level}
          </Text>
        </Box>
        {/* <Box width={widths[2]} flexShrink={0}>
          <Text wrap='truncate'>
            {name}
          </Text>
        </Box> */}
        <Box width={msgWidth} flexShrink={0}>
          <Text wrap='truncate' color={selected.includes(matching.at(linePos)) ? 'blue': null} inverse={linePos === pos}>
            {msg}
          </Text>
        </Box>
        {cols.map((col, idx) => (
          <Box width={widths[4 + idx]} flexShrink={1}>
            <Text wrap='truncate' dimColor>
              {col}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }
  const { time, level, name, msg, pid, hostname, ...rest } = messages[matching.at(pos)] ?? {}

  return (
    <Box flexDirection='column' height={rows} width={columns}>
      <Box gap='1' flexWrap='nowrap'>
        <Text wrap='truncate-middle'>Line: {matching.at(pos)}</Text>
        <Text>Matching: {matching.length}</Text>
        {scan !== messages.length ? <Text>Scanned: {scan}</Text> : null}
        <Text>Total: {messages.length}</Text>
        <Text>Mem: {Math.round(process.memoryUsage().rss / 1e6)} MB</Text>
      </Box>
      <Box
        ref={ref}
        borderStyle={inspect ? 'single' : 'double'}
        flexDirection='column'
        flexWrap='nowrap'
        flexBasis={4}
        flexGrow={inspect ? 0 : 2}
      >
        <Box flexWrap='nowrap' gap='1'>
          <Box width={widths[0]} flexShrink={0}>
            <Text dimColor>Date</Text>
          </Box>
          <Box width={widths[1]} flexShrink={0}>
            <Text dimColor>Level</Text>
          </Box>
          {/* <Box width={widths[2]} height={1} overflowY='hidden'>
            <Text dimColor>Name</Text>
          </Box> */}
          <Box width={msgWidth} flexShrink={0} height={1} overflowY='hidden'>
            <Text dimColor>Message</Text>
          </Box>
          {fields.map((field, idx) => (
            <Box key={idx} width={widths[4 + idx]} flexShrink={1}>
              <Text wrap='truncate' dimColor>
                {field}
              </Text>
            </Box>
            ))}
        </Box>
        {lines}
      </Box>
      <ScrollBox key={matching[pos]} focus={inspect} borderStyle={inspect ? 'double' : 'single'} overflow='hidden' flexBasis={0} flexGrow={1}>
        {formatObject(rest, { lineWidth: columns - 4 })}
      </ScrollBox>
      <Text>{filters.map((fn) => fn.label ?? fn.toString()).join(' & ')}</Text>
      {prompt ? <TextInput value={query} onChange={setQuery} onSubmit={() => {
        const filterFn = msg => JSON.stringify(msg).includes(query)
        filterFn.label = `/${query}`
        filters.push(filterFn)
        rescan()
        setPrompt(false)
      }}/> : null}
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
      setScroll(x => Math.max(x - 1, 0))
    } else if (key.downArrow) {
      setScroll(x => Math.min(x + 1, Math.max(0, contentHeight - boxHeight)))
    }
  })

  const ref = React.useRef();

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

/*
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

const container = await prompt({
  type: 'list',
  message: 'What container do you want to debug?',
  choices: containers.map(([id, image, name]) => ({
    name: `${name.match(/^[\w-]+\.\d+/) || name} ${image}`,
    short: id,
    value: id,
  })),
})

const dockerLogsProc = spawn('docker', ['logs', '-f', container], { stdio: ['ignore', 'pipe', 'pipe'] })

const services = execFileSync(
  'docker',
  ['service', 'ls', '--format', '{{.ID}}\\t{{.Image}}\\t{{.Names}}'],
  { encoding: 'utf8' }
)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'))
  .sort((a, b) => a[2].localeCompare(b[2]))

const container = await prompt({
  type: 'list',
  message: 'What service do you want to debug?',
  choices: services.map(([id, image, name]) => ({
    name: `${name.match(/^[\w-]+\.\d+/) || name} ${image}`,
    short: id,
    value: id,
  })),
})

const dockerLogsProc = spawn('docker', ['logs', '-f', container], { stdio: ['ignore', 'pipe', 'pipe'] })
*/

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
      setState(state => ({
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

    let scan = 0
    let resume = null
    let completed = 0
    let status = 'starting...'
    const messages = []
    const matching = []
    const filters = [() => true]

    let scanPosition
    let scanToDate
    function rescan (date) {
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
            matching.push(scan)
            if (scanPosition === undefined && scanToDate && new Date(message.time) >= scanToDate) {
              scanPosition = matching.length - 1
              scanToDate = null
            }
          }
          ++scan
          if ((Date.now() - start) > 100) {
            break
          }
        }
        setState(state => ({ ...state, scanPosition, scan, status, messages, matching, filters, completed, rescan }))
        if (scan < messages.length) {
          await tp.setTimeout(1)
          continue
        }
        // wait for resume...
        await new Promise((resolve) => {
          resume = resolve
        })
        resume = null
      }
    }
    loop().catch((err) => console.error('error', err))

    status = `reading files (${completed}/${inputs.length})`

    Promise.all(inputs.map(async (input, idx) => {
      await pipeline(
        input,
        split(parseLine),
        async (msgs) => {
          for await (const msg of msgs) {
            messages.push(inputs > 1 ? { ...msg, _input: idx } : msg)
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
    })).then(() => {
      status = 'end of file'
    }, (err) => {
      status = 'error reading input: ' + err.message
    })

    return () => {
      ac.abort()
      resume?.()
    }
  }, [])

  return <Main {...state} />
}

// const enterAltScreenCommand = '\x1b[?1049h'
// const leaveAltScreenCommand = '\x1b[?1049l'

const { waitUntilExit } = render(<App columns={process.stdout.columns} rows={process.stdout.rows} />, { stdin: input })
await waitUntilExit()
fs.closeSync(ttyfd)

function parseLine (row) {
  try {
    if (row) return JSON.parse(row)
  } catch (err) {
    return { msg: row, err, level: 100 }
  }
}
