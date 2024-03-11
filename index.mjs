#!/usr/bin/env node
import { pipeline } from 'node:stream/promises'
import ndjson from 'ndjson'
import fs from 'node:fs'
import tp from 'node:timers/promises'
import tty from 'node:tty'
import React from 'react'
import { formatLevel, formatObject, formatTime } from './format.mjs'
import { render, Text, Box, useInput } from 'ink'
import fp from 'lodash/fp.js'
import TextInput from 'ink-text-input'

let scan = 0
let update = null
let position = 0
let status = 'reading file'
const messages = []
const matching = []
const filters = [() => true]

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

const input = tty.ReadStream(fs.openSync('/dev/tty', 'r'))
input.setRawMode(true).setEncoding('utf8')

function Main({ rows, columns }) {
  const pos = position ?? matching.length - 1

  const [inspect, setInspect] = React.useState()
  const [selected, setSelected] = React.useState([])
  const [prompt, setPrompt] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const numLines = inspect ? 1 : Math.floor(rows / 2)

  const [key, setKey] = React.useState()
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

    // This is a hack to force refresh...
    setKey({ input, key })

    // upArrow downArrow leftArrow rightArrow pageDown pageUp return escape ctrl shift tab backspace delete meta
    if (key.upArrow) {
      position = Math.max(pos - 1, 0)
    } else if (key.downArrow) {
      position = Math.min(pos + 1, matching.length - 1)
    } else if (key.pageUp) {
      position = Math.max(pos - numLines, 0)
    } else if (key.pageDown) {
      position = Math.min(pos + numLines, matching.length - 1)
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
        position = next !== -1 ? next : undefined
        break
      }
      case 'M': {
        const next = matching.slice(0, pos).findLastIndex((x) => selected.includes(x))
        position = next !== -1 ? next : 0
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
        const { msg } = messages[matching.at(position)] || {}
        if (msg) {
          const fn = (x) => x.msg !== msg
          fn.label = `msg != "${msg}"`
          filters.push(fn)
          rescan()
        }
        break
      }
      case '+': {
        const { msg } = messages[matching.at(position)] || {}
        if (msg) {
          const fn = (x) => x.msg === msg
          fn.label = `msg != "${msg}"`
          filters.push(fn)
          rescan()
        }
        break
      }
      case 'g': {
        position = 0
        break
      }
      case 'F': {
        position = undefined
        break
      }
      case 'G': {
        position = matching.length - 1
        break
      }
      case 'q': {
        process.exit()
      }
    }
  })

  const fields = ['seq', 'err.message']
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
  const msgWidth = columns - (widths.reduce((xs, x) => xs + x, 0) - widths[3])

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
      <Box flexWrap='nowrap' gap='1'>
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
        <Box width={Math.min(widths[3], Math.max(msgWidth, Math.round(columns * 0.25)))} flexShrink={0}>
          <Text wrap='truncate' color={selected.includes(matching.at(linePos)) ? 'blue': null} inverse={linePos === pos ? true : false}>
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
        borderStyle={inspect ? 'single' : 'double'}
        flexDirection='column'
        flexWrap='nowrap'
        height={numLines + 3}
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
          <Box width={Math.min(widths[3], 32)} flexShrink={0} height={1} overflowY='hidden'>
            <Text dimColor>Message</Text>
          </Box>
          {fields.map((field, idx) => (
            <Box width={widths[4 + idx]} flexShrink={1}>
              <Text wrap='truncate' dimColor>
                {field}
              </Text>
            </Box>
            ))}
        </Box>
        {lines}
      </Box>
      <ScrollBox key={matching[pos]} focus={inspect} boxHeight={rows - 8} borderStyle={inspect ? 'double' : 'single'} overflow='hidden' flexBasis={0} flexGrow={1}>
        {formatObject(rest, { lineWidth: columns - 4 })}
      </ScrollBox>
      <Text>{filters.map((fn) => fn.label ?? fn.toString()).join(' & ')}</Text>
      {prompt ? <TextInput value={query} onChange={setQuery} onSubmit={() => {
        const filterFn = msg => JSON.stringify(msg).includes(query)
        filterFn.label = `/${prompt}`
        filters.push(filterFn)
        rescan()
        setPrompt(false)
      }}/> : null}
    </Box>
  )
}

function ScrollBox({ focus, boxHeight, children, ...props }) {
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
  return (
    <Box {...props}>
      <Text>{lines.slice(scroll).join('\n')}</Text>
    </Box>
  )
}

const enterAltScreenCommand = '\x1b[?1049h'
const leaveAltScreenCommand = '\x1b[?1049l'
process.stdout.on('resize', () => {
  redraw()
})

let scanToDate
function rescan() {
  if (position != null) {
    scanToDate = new Date(messages[matching.at(position)]?.time)
  }
  scan = matching.length = 0
  position = undefined
  update()
}

function redraw() {
  render(<Main columns={process.stdout.columns} rows={process.stdout.rows} />, { stdin: input })
}

async function loop() {
  while (true) {
    const start = Date.now()
    while (scan < messages.length) {
      const message = messages[scan]
      if (filters.every((fn) => fn(message))) {
        matching.push(scan)
        if (position === undefined && scanToDate && new Date(message.time) >= scanToDate) {
          position = matching.length - 1
          scanToDate = null
        }
      }
      ++scan
      if ((Date.now() - start) > 100) {
        break
      }
    }
    redraw()
    if (scan < messages.length) {
      await tp.setTimeout(50)
      continue
    }
    await new Promise((resolve) => {
      update = resolve
    })
  }
}
loop().catch((err) => console.log('error', err))

let dirty = false
setInterval(() => {
  if (dirty) {
    update()
    dirty = false
  }
}, 100)

const inputs = process.argv.length > 2 ? process.argv.slice(1).map(path => fs.createReadStream(path)) : [process.stdin]
await Promise.all(inputs.map(async input => {
  await pipeline(
    input,
    ndjson.parse({ strict: false }),
    async (msgs) => {
      for await (const msg of msgs) {
        messages.push(msg)
        dirty = true
      }
      
    }
  ).catch((err) => {
    status = err.message
  })
  // status = 'end of file'
}))