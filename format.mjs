import YAML from 'yaml'

const dtf = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
})

export function formatTime(time) {
  const date = time ? new Date(time) : null
  if (isNaN(date)) {
    return '<invalid date>'
  }
  return dtf.format(date)
}

export function formatLevel(level) {
  if (level == null || !Number.isFinite(level)) {
    return '?'
  }
  if (level >= 60) {
    return 'FATAL'
  } else if (level >= 50) {
    return 'ERROR'
  } else if (level >= 40) {
    return 'WARN'
  } else if (level >= 30) {
    return 'INFO'
  } else if (level >= 20) {
    return 'DEBUG'
  } else {
    return 'TRACE'
  }
}

export function formatObject(obj, opts) {
  return YAML.stringify(obj, { blockQuote: 'literal', aliasDuplicateObjects: false, ...opts })
}
