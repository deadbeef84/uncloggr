#!/usr/bin/env node
import { pipeline } from 'node:stream/promises'
import split from 'split2'
import fs from 'node:fs'
import tp from 'node:timers/promises'
import tty from 'node:tty'
import React from 'react'
import { formatLevel, formatNumber, formatObject, formatTime } from './format.mjs'
import { render, Text, Box, Spacer, useApp, useInput, measureElement } from 'ink'
import fp from 'lodash/fp.js'
import TextInput from 'ink-text-input'
import inquirer from 'inquirer'
import { parseArgs } from 'node:util'
import { getDocker, getDockerServices, getFile, getPM2, getStdin } from './sources.mjs'

const prompt = async (question) => (await inquirer.prompt([{ ...question, name: 'answer' }])).answer

const { values: opts, positionals: argv } = parseArgs({
  options: {
    all: {
      type: 'boolean',
      short: 'a',
    },
    follow: {
      type: 'boolean',
      short: 'f',
      default: true,
    },
    since: {
      type: 'string',
    },
    tail: {
      type: 'string',
      short: 'n',
    },
    sort: {
      type: 'boolean',
      short: 's',
    },
    help: {
      type: 'boolean',
      short: 'h'
    },
    version: {
      type: 'boolean',
      short: 'v'
    }
  },
  allowPositionals: true,
  strict: true,
})

if (opts.version) {
  const pkg = JSON.parse((fs.readFileSync(new URL('../package.json', import.meta.url))))
  console.log(`uncloggr version: ${pkg.version}`)
  process.exit(0)
}

if (opts.help) {
  console.log(`
Usage: uncloggr [OPTIONS] [sources...]

Options:
  -a --all          Include all sources (stopped containers)
  -f --follow       Follow log output
     --since string Show logs since timestamp (e.g. "2013-01-02T13:23:37Z") or relative (e.g. "42m" for 42 minutes)
  -n --tail string  Number of lines to show from the end of logs
  -s --sort         Sort logs by time, slower but useful when reading multiple sources
  -h --help         This help
  -v --version
`)
  process.exit(0)
}

const sources = argv.length ? argv : process.stdin.isTTY ? [''] : ['stdin:-']
const inputs = []

const types = {
  pm2: getPM2,
  docker: getDocker,
  'docker-service': getDockerServices,
  file: getFile,
  stdin: getStdin,
}

for (const source of sources) {
  const [, type, pattern] = source?.match(/^([a-z-]+:)?([^:]*)$/i) ?? []
  const from = type
    ? types[type.slice(0, -1)]?.(pattern, opts) ?? []
    : Object.entries(types).flatMap(([type, fn]) => {
        try {
          // docker-service is buggy, so skip...
          if (type === 'docker-service') {
            return []
          }
          return fn(pattern, opts)?.map((x) => ({
            ...x,
            type,
            value: `${type}:${x.value ?? x.name}`,
          }))
        } catch (err) {
          console.log(`${type}: ${err.message}`)
          return []
        }
      })
  if (from.length === 1) {
    inputs.push(...from[0].read(opts))
  } else if (from.length > 1) {
    let choice
    while (!choice?.length) {
      try {
        choice = await prompt({
          type: 'checkbox',
          message: 'From where?',
          choices: from.sort((a, b) => a.name.localeCompare(b.name)),
          validate: (answers) => answers.length ? true : 'You must select a source',
        })
      } catch {
        process.exit(1)
      }
    }
    inputs.push(
      ...from.filter((x) => choice.includes(x.value)).flatMap((source) => source.read(opts))
    )
  } else {
    console.error(source ? `Source not found: ${source}` : 'No source specified')
    process.exit(1)
  }
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

const filterNull = () => true
filterNull.label = ''
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

const SHORTCUTS = [
  { key: 'j / ↓', desc: 'Move down one line' },
  { key: 'k / ↑', desc: 'Move up one line' },
  { key: 'Ctrl+d / PgDn', desc: 'Move down half page' },
  { key: 'Ctrl+u / PgUp', desc: 'Move up half page' },
  { key: 'h / ←', desc: 'Select previous field' },
  { key: 'l / →', desc: 'Select next field' },
  { key: 'g', desc: 'Go to first line' },
  { key: 'G', desc: 'Go to last line' },
  { key: 'F', desc: 'Follow mode (jump to end)' },
  { key: '1-6', desc: 'Filter by log level (1=TRACE to 6=FATAL)' },
  { key: '+', desc: 'Include: filter to entries where field equals current value' },
  { key: '-', desc: 'Exclude: filter out entries where field equals current value' },
  { key: '&', desc: 'Add custom text filter' },
  { key: '=', desc: 'Add custom expression filter (JavaScript eval)' },
  { key: 'Backspace', desc: 'Remove last filter' },
  { key: 'Meta+Backspace', desc: 'Clear all filters' },
  { key: '/', desc: 'Search forward' },
  { key: 'n', desc: 'Next search result' },
  { key: 'N', desc: 'Previous search result' },
  { key: 'Space', desc: 'Toggle selection on current line' },
  { key: 'm', desc: 'Jump to next selected line' },
  { key: 'M', desc: 'Jump to previous selected line' },
  { key: 's', desc: 'Sort messages by timestamp' },
  { key: '*', desc: 'Add new field to display' },
  { key: '\\', desc: 'Remove selected field from display' },
  { key: 'Enter', desc: 'Toggle detailed inspection view' },
  { key: 'Shift+↓ / Shift+↑', desc: 'Next/previous log item when in inspector view' },
  { key: 'c', desc: 'Clear all messages' },
  { key: 'q', desc: 'Quit application' },
  { key: '?', desc: 'Show this help popup' },
]

function HelpPopup() {
  return (
    <Box
      flexDirection='column'
      borderStyle='round'
      borderColor='cyan'
      padding={1}
      marginX={2}
      marginY={1}
    >
      <Text bold>Keyboard Shortcuts (Press any key to close)</Text>
      <Text></Text>
      {SHORTCUTS.map((shortcut, idx) => (
        <Box key={idx} gap={2}>
          <Box width={16} flexShrink={0}>
            <Text bold color='yellow'>{shortcut.key}</Text>
          </Box>
          <Text>{shortcut.desc}</Text>
        </Box>
      ))}
    </Box>
  )
}

function Main(props) {
  const {
    rows,
    columns,
    scan,
    status,
    messages,
    matching,
    filters,
    rescan,
    sorted,
  } = props

  const { exit } = useApp()
  const [item, setItem] = React.useState(undefined) // undefined = last
  const [fields, setFields] = React.useState(['time', 'level', 'name', 'msg'])
  const [selectedField, setSelectedField] = React.useState(3)
  const [inspect, setInspect] = React.useState()
  const [selected, setSelected] = React.useState([])
  const [prompt, setPrompt] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState(null)
  const [showHelp, setShowHelp] = React.useState(false)

  const ref = React.useRef()
  const [numLines, setNumLines] = React.useState(0)
  React.useEffect(() => {
    const { height } = measureElement(ref.current)
    setNumLines(height - 2) // excluding header + borders
  })

  function getPosition() {
    if (item === undefined) {
      return matching.length - 1
    } else if (item) {
      let idx = matching.findIndex((idx) => messages[idx] === item)
      if (idx === -1) {
        if (sorted) {
          idx = matching.findIndex((index) => messages[index]._sort > item._sort)
        } else {
          let messagesIdx = messages.indexOf(item)
          idx = matching.findIndex((idx) => idx > messagesIdx)
        }
      }
      return idx === -1 ? matching.length - 1 : idx
    }
    return 0
  }

  function move (rel) {
    const pos = Math.max(0, Math.min(matching.length - 1, getPosition() + rel))
    setItem(messages[matching[pos]])
  }

  useInput((input, key) => {
    const pos = getPosition()

    function searchNext(query) {
      if (!query) {
        return
      }

      const searchFn = (msg) => JSON.stringify(msg).includes(query)
      const idx = matching.find((x, idx) => idx > pos && searchFn(messages[x]))
      setItem(idx !== undefined ? messages[idx] : undefined)
    }

    if (showHelp) {
      setShowHelp(false)
      return
    }

    if (prompt) {
      if (key.escape) {
        setPrompt(null)
      }
      return
    }

    if (inspect) {
      if (key.escape || key.return) {
        setInspect(false)
      } else if (key.shift && key.upArrow) {
        move(-1)
      } else if (key.shift && key.downArrow) {
        move(1)
      }
      return
    }

    // upArrow downArrow leftArrow rightArrow pageDown pageUp return escape ctrl shift tab backspace delete meta
    if (key.upArrow || input === 'k') {
      move(-1)
    } else if (key.downArrow || input === 'j') {
      move(1)
    } else if (key.pageUp || (key.ctrl && input === 'u')) {
      move(-numLines)
    } else if (key.pageDown || (key.ctrl && input === 'd')) {
      move(numLines)
    } else if (key.leftArrow || input === 'h') {
      setSelectedField(Math.max(selectedField - 1, 0))
    } else if (key.rightArrow || input === 'l') {
      setSelectedField(Math.min(selectedField + 1, fields.length - 1))
    } else if (key.return) {
      setInspect(!inspect)
    } else if (key.delete || key.backspace) {
      if (key.meta || filters.length === 1) {
        filters.length = 1
        filters[0] = filterNull
      } else {
        filters.pop()
      }
      rescan()
    }

    switch (input) {
      case ' ':
        setSelected((selected) => {
          const item = matching[pos]
          const idx = selected.indexOf(item)
          if (idx === -1) {
            return [...selected, item]
          } else {
            return selected.toSpliced(idx, 1)
          }
        })
        break
      case 'm': {
        const idx = matching.find((x, idx) => idx > pos && selected.includes(x))
        setItem(idx !== undefined ? messages[idx] : undefined)
        break
      }
      case 'M': {
        const idx = matching.slice(0, pos).findLast((x) => selected.includes(x))
        setItem(idx !== undefined ? messages[idx] : messages[matching[0]])
        break
      }
      case 's': {
        const selectedItems = selected.map((idx) => messages[idx])
        messages.sort((a, b) => a._sort.localeCompare(b._sort))
        rescan()
        setSelected(selectedItems.map((item) => messages.indexOf(item)))
        break
      }
      case '\\':
        setFields(fields.toSpliced(selectedField, 1))
        break
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
      case '&': {
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
      case '/': {
        setPrompt({
          label: 'Search',
          onSubmit: (query) => {
            setSearch(query)
            searchNext(query)
          },
        })
        break
      }
      case 'n': {
        searchNext(search)
        break
      }
      case 'N': {
        if (search) {
          const searchFn = (msg) => JSON.stringify(msg).includes(search)
          const idx = matching.slice(0, pos).findLast((x) => searchFn(messages[x]))
          setItem(idx !== undefined ? messages[idx] : messages[matching[0]])
        }
        break
      }
      case '=': {
        const field = fields[selectedField]
        setQuery(`this.${field}`)
        setPrompt({
          label: 'Expression',
          onSubmit: (query) => {
            const filterFn = function (msg) {
              return eval(query)
            }
            filterFn.label = query
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
        const field = fields[selectedField]
        const value = fp.get(field, messages[matching.at(pos)])
        const fn = (x) => !fp.isEqual(fp.get(field, x), value)
        fn.label = `${field} != ${JSON.stringify(value) ?? 'undefined'}`
        filters.push(fn)
        rescan()
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
        setItem(messages[matching.at(0)])
        break
      }
      case 'F': {
        setItem(undefined)
        break
      }
      case 'G': {
        setItem(messages[matching.at(-1)])
        break
      }
      case 'q': {
        exit()
      }
      case '?': {
        setShowHelp(!showHelp)
      }
    }
  })

  const data = []

  let pos = getPosition()
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
          return JSON.stringify(value).slice(1, -1)
        } else if (typeof value === 'number') {
          return formatNumber(value)
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
          <Box
            key={idx}
            width={widths[idx]}
            flexShrink={['time', 'level', 'name'].includes(fields[idx]) ? 0 : 1}
            flexGrow={fields[idx] === 'msg'}
          >
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
      <Box
        ref={ref}
        flexDirection='column'
        flexWrap='nowrap'
        flexBasis={4}
        flexGrow={inspect ? 0 : 2}
      >
        <Box
          flexWrap='nowrap'
          gap='1'
          borderStyle='single'
          borderLeft={false}
          borderRight={false}
          borderTop={false}
        >
          {fields.map((field, idx) => (
            <Box
              key={idx}
              width={widths[idx]}
              flexShrink={['time', 'level', 'name'].includes(field) ? 0 : 1}
              flexGrow={field === 'msg' ? 1 : 0}
              height={1}
              overflowY='hidden'
              overflowX='hidden'
            >
              <Text wrap='truncate' dimColor>
                {field}
              </Text>
            </Box>
          ))}
        </Box>
        {lines}
      </Box>
      <Text>
        {Array.from({ length: columns }, (_, idx) =>
          idx / columns > scan / messages.length ? '-' : '═'
        ).join('')}
      </Text>
      <ScrollBox
        key={matching[pos]}
        focus={inspect}
        borderStyle='double'
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={inspect ? 'blue' : ''}
        overflow='hidden'
        flexBasis={0}
        flexGrow={1}
      >
        {formatObject(rest, { lineWidth: columns - 4 })}
      </ScrollBox>
      {showHelp ? (
        <HelpPopup />
      ) : prompt ? (
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
          <Spacer />
          <Text>.</Text>
        </Box>
      ) : (
        <Box gap='1'>
          <Text>
            {filters
              .map((fn) => fn.label ?? fn.toString())
              .filter(Boolean)
              .join(' & ') || 'No filters'}
          </Text>
          <Spacer />
          <Text>Mem: {Math.round(process.memoryUsage().rss / 1e6)} MB</Text>
          <Spacer />
          <Text>Matching: {matching.length}</Text>
          <Text>Total: {messages.length}</Text>
        </Box>
      )}
    </Box>
  )
}

function ScrollBox({ focus, children, ...props }) {
  const [boxHeight, setBoxHeight] = React.useState(0)
  const lines = children.split('\n')
  const contentHeight = lines.length
  const [scroll, setScroll] = React.useState(0)

  useInput((input, key) => {
    if (!focus) {
      return
    }
    if (key.upArrow) {
      setScroll((x) => Math.max(x - 1, 0))
    } else if (key.downArrow) {
      setScroll((x) => Math.min(x + 1, Math.max(0, contentHeight - boxHeight)))
    } else if (key.pageUp || (key.ctrl && input === 'u')) {
      setScroll((x) => Math.max(x - Math.floor(boxHeight / 2), 0))
    } else if (key.pageDown || (key.ctrl && input === 'd')) {
      setScroll((x) => Math.min(x + Math.floor(boxHeight / 2), Math.max(0, contentHeight - boxHeight)))
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
    const filters = [filterNull]

    function rescan() {
      scan = matching.length = 0
      resume?.()
    }

    async function loop() {
      while (!ac.signal.aborted) {
        const start = Date.now()
        while (scan < messages.length) {
          const message = messages[scan]
          if (filters.every((fn) => fn.call(message, message))) {
            if (sort) {
              const idx = fp.sortedIndexBy((idx) => messages[idx]._sort, scan, matching)
              matching.splice(idx, 0, scan)
            } else {
              matching.push(scan)
            }
          }
          ++scan
          if (Date.now() - start > 100) {
            break
          }
        }
        setState((state) => ({
          ...state,
          sorted: sort,
          scan,
          status,
          messages,
          matching,
          filters,
          completed,
          rescan,
        }))
        await tp.setTimeout(20)
        if (scan < messages.length) {
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
            let time = 0
            let line = 0
            for await (const msg of msgs) {
              ++line
              if ('time' in msg) {
                time = new Date(msg.time).getTime() || 0
              }
              msg._sort = `${String(time).padStart(13, '0')}:${String(idx).padStart(4, '0')}:${String(line).padStart(9, '0')}`
              msg._from = input.label ?? idx
              msg._line = line
              messages.push(msg)
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

const enterAltScreenCommand = '\x1b[?1049h'
const leaveAltScreenCommand = '\x1b[?1049l'

process.stdout.write(enterAltScreenCommand)
const { waitUntilExit } = render(
  <App columns={process.stdout.columns} rows={process.stdout.rows} />,
  { stdin: input }
)

await waitUntilExit()
process.stdout.write(leaveAltScreenCommand)

// input.setRawMode(false)
// input.destroy()
// fs.closeSync(ttyfd)
// console.log('all done')
process.exit(0)

function parseLine(row) {
  try {
    if (!row || row[0] !== '{') {
      return { msg: row, level: 100 }
    }
    return JSON.parse(row)
  } catch (err) {
    return { msg: row, level: 100 }
  }
}
