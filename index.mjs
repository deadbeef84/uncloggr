// node --watch index.mjs ../../tv2-enps/migration-tv2k-full1.log
import { pipeline } from 'stream/promises'
import ndjson from 'ndjson'
import fs from 'node:fs'
import React from 'react'
import { render, Text, Box, useInput } from 'ink'
import { formatLevel, formatObject, formatRest, formatTime } from './format.mjs'

let scan = 0
let update = null
let position = 0
const messages = []
const matching = []
const filters = [() => true]

function applyFilters(line) {
  return filters.every((fn) => fn(line))
}

function levelProps(level) {
  if (level >= 60) {
    return { color: 'red' }
  } else if (level >= 50) {
    return { color: 'red' }
  } else if (level >= 40) {
    return { color: 'yellow' }
  } else if (level >= 30) {
    return { color: 'blue' }
  } else if (level >= 20) {
    return {}
  } else {
    return { dimColor: true }
  }
}

const filterTrace = (x) => x.level >= 10
filterTrace.label = 'LEVEL>=TRACE'
const filterDebug = (x) => x.level >= 10
filterDebug.label = 'LEVEL>=DEBUG'
const filterInfo = (x) => x.level >= 10
filterInfo.label = 'LEVEL>=INFO'
const filterWarning = (x) => x.level >= 10
filterWarning.label = 'LEVEL>=WARNING'
const filterError = (x) => x.level >= 10
filterError.label = 'LEVEL>=ERROR'
const filterFatal = (x) => x.level >= 10
filterFatal.label = 'LEVEL>=FATAL'

function Main({ rows, columns }) {
  const pos = position ?? matching.length - 1

  const [inspect, setInspect] = React.useState()

  const numLines = inspect ? 1 : Math.floor(rows / 2)

  const [key, setKey] = React.useState()
  useInput((input, key) => {
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

  const lines = []
  const start = Math.max(pos - Math.floor(numLines / 2), -1)
  for (let linePos = start; linePos < start + numLines; ++linePos) {
    if (linePos < 0) {
      if (linePos === -1) {
        lines.push(<Text color='blue' dimColor>[start of file]</Text>)
      }
      continue
    }
    if (linePos >= matching.length) {
      if (linePos === matching.length) {
        lines.push(<Text color='blue' dimColor>[end of file]</Text>)
      }
      continue
    }
    const { time, level, msg = '', pid, hostname, ...rest } = messages[matching.at(linePos)] || {}
    lines.push(
      <Box flexWrap='nowrap' gap='1'>
        <Box minWidth={12}>
          <Text wrap='truncate' dimColor>
            {formatTime(time)}
          </Text>
        </Box>
        <Box minWidth={7}>
          <Text wrap='truncate' {...levelProps(level)}>
            {formatLevel(level)}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text wrap='truncate' color={linePos === pos ? 'inverse' : ''}>
            {msg}
          </Text>
        </Box>
        <Box flexShrink={100}>
          <Text wrap='truncate' dimColor>
            {formatRest(rest)}
          </Text>
        </Box>
      </Box>
    )
  }
  const { time, level, msg, pid, hostname, ...rest } = messages[matching.at(pos)] ?? {}

  return (
    <Box flexDirection='column' height={rows} width={columns}>
      <Box gap='1' flexWrap='nowrap'>
        <Text wrap='truncate-middle'>Position: {matching.at(pos)}</Text>
        <Text>Matching: {matching.length}</Text>
        <Text>Scanned: {scan}</Text>
        <Text>Total: {messages.length}</Text>
        <Text>Mem: {Math.round(process.memoryUsage().rss / 1e6)} MB</Text>
      </Box>
      <Box borderStyle={inspect ? 'single' : 'double'} flexDirection='column' flexWrap='nowrap' height={numLines + 3}>
        <Box flexWrap='nowrap' gap='1'>
          <Box width={12}>
            <Text dimColor>Date</Text>
          </Box>
          <Box width={7}>
            <Text dimColor>Level</Text>
          </Box>
          <Text dimColor>Message {filters.map(fn => fn.label ?? fn.toString()).join(' & ')}</Text>
        </Box>
        {lines}
      </Box>
      <Box borderStyle={inspect ? 'double' : 'single'} overflow='hidden' flexBasis={0} flexGrow={1}>
        <Text>{formatObject(rest, { lineWidth: columns - 4 })}</Text>
      </Box>
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
  render(<Main columns={process.stdout.columns} rows={process.stdout.rows} />)
}

async function loop() {
  while (true) {
    const interval = setInterval(() => redraw(), 100)
    while (scan < messages.length) {
      if (applyFilters(messages[scan])) {
        matching.push(scan)
        if (position === undefined && scanToDate && new Date(messages[scan].time) >= scanToDate) {
          position = matching.length - 1
          scanToDate = null
        }
      }
      ++scan
    }
    clearInterval(interval)
    redraw()
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

await pipeline(
  process.argv.length > 2 ? fs.createReadStream(process.argv.at(-1)) : process.stdin,
  ndjson.parse(),
  async (msgs) => {
    for await (const msg of msgs) {
      messages.push(msg)
      dirty = true
    }
  }
).catch((err) => {})
