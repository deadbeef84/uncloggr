// node --watch index.mjs ../../tv2-enps/migration-tv2k-full1.log
import { pipeline } from 'stream/promises'
import ndjson from 'ndjson'
import 'colors'
import fs from 'node:fs'
import tty from 'node:tty'
import YAML from 'yaml'
import { ZSTDCompress, ZSTDDecompress } from 'simple-zstd'

let scan = 0
let update = null
const cached = []
const matching = []
const window = { start: 0, length: 20 }
const filters = [(x) => x.level >= 30]

const input = tty.ReadStream(fs.openSync('/dev/tty', 'r'))
input
  .setRawMode(true)
  .setEncoding('utf8')
  .on('data', (ch) => {
    ch = ch + ''

    // console.log('input', Buffer.from(ch))

    switch (ch) {
      case '\u001b[A': // up
        window.start--
        break
      case '\u001b[B': // down
        window.start++
        break
      case '\u001b[D': // right
      case '\u001b[C': // left
        //
        break
      case '\n':
      case '\r':
      case '\u0004':
        // Enter
        break
      case '\u0008':
      case '\u007F':
        // backspace
        break
      case '\u0003':
        // Ctrl-C
        process.exit()
        break
      case '1':
        filters[0] = (x) => x.level >= 10
        scan = matching.length = 0
        break
      case '2':
        filters[0] = (x) => x.level >= 20
        scan = matching.length = 0
        break
      case '3':
        filters[0] = (x) => x.level >= 30
        scan = matching.length = 0
        break
      case '4':
        filters[0] = (x) => x.level >= 40
        scan = matching.length = 0
        break
      case '5':
        filters[0] = (x) => x.level >= 50
        scan = matching.length = 0
        break
      case '6':
        filters[0] = (x) => x.level >= 60
        scan = matching.length = 0
        break
      case '-': {
        const { msg } = cached[matching.at(window.start)] || {}
        if (msg) {
          filters.push((x) => x.msg !== msg)
          scan = matching.length = 0
        }
        break
      }
      case '+': {
        const { msg } = cached[matching.at(window.start)] || {}
        if (msg) {
          filters.push((x) => x.msg === msg)
          scan = matching.length = 0
        }
        break
      }
      case 'g': {
        window.start = 0
        break
      }
      case 'G': {
        window.start = matching.length
        break
      }
      default:
        console.log('input', ch, Buffer.from(ch))
        return
    }
    update()
  })

function applyFilters(line) {
  return filters.every((fn) => fn(line))
}

const dtf = new Intl.DateTimeFormat('sv-SE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
})
function formatTime(time) {
  if (!time) {
    return '?'
  }
  return dtf.format(new Date(time))
}

function formatLevel(level) {
  if (level == null || !Number.isFinite(level)) {
    return '?'
  }
  if (level >= 60) {
    return 'F'.bgRed
  } else if (level >= 50) {
    return 'E'.red
  } else if (level >= 40) {
    return 'W'.yellow
  } else if (level >= 30) {
    return 'I'.blue
  } else if (level >= 20) {
    return 'D'
  } else {
    return 'T'.grey
  }
}

function formatObject(obj) {
  return YAML.stringify(obj, { blockQuote: 'literal', aliasDuplicateObjects: false })
}

function redraw() {
  console.clear()
  console.log(
    `${matching.at(window.start)} (${matching.length}/${scan}/${cached.length}) memory ${Math.round(
      process.memoryUsage().rss / 1e6
    )} MB`
  )
  const start = Math.max(window.start - 10, window.start >= 0 ? 0 : -10000)
  for (let pos = start; pos < start + window.length; ++pos) {
    if (!cached[matching.at(pos)]) {
      console.log('-')
      continue
    }
    const {
      time = Date.now(),
      level,
      msg = '',
      pid,
      hostname,
      ...rest
    } = cached[matching.at(pos)] || {}
    const fields = [
      formatTime(time).dim,
      formatLevel(level),
      msg.white,
      Object.entries(rest)
        .map(
          ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
        )
        .join(' ')
        .slice(0, 80 - msg.length)
        .dim,
    ]
    console.log(pos === window.start ? fields.join(' ').bgWhite : fields.join(' '))
  }
  const { time, level, msg, pid, hostname, ...rest } = cached[matching.at(window.start)] ?? {}
  console.log('='.repeat(30))
  console.log(formatObject(rest))
}

async function loop() {
  while (true) {
    while (scan < cached.length) {
      if (applyFilters(cached[scan])) {
        matching.push(scan)
      }
      ++scan
    }
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
}, 400)

await pipeline(
  process.argv.length > 2 ? fs.createReadStream(process.argv.at(-1)) : process.stdin,
  // ZSTDCompress(3),
  // async function * (chunks) {
  //   let buf = Buffer.alloc(0)
  //   for await (const chunk of chunks) {
  //     buf = Buffer.concat([buf, chunk])
  //     yield chunk
  //   }
  // },
  // ZSTDDecompress(),
  ndjson.parse(),
  async (messages) => {
    for await (const message of messages) {
      cached.push(message)
      dirty = true
    }
  }
)
