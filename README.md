# uncloggr

A powerful terminal-based log viewer with an interactive interface. View and filter logs from PM2, Docker containers, files, or stdin with real-time updates and advanced filtering capabilities.

## Features

- **Multiple Log Sources**: Read from PM2 processes, Docker containers, Docker services, files, or stdin
- **Interactive TUI**: Built with React/Ink for a smooth terminal experience
- **Real-time Updates**: Follow logs as they're written with automatic updates
- **Advanced Filtering**: Filter by log level, field values, or custom expressions
- **Search**: Find specific entries with forward/backward search
- **Custom Fields**: Add or remove fields from the display
- **Sorting**: Sort logs by timestamp across multiple sources
- **Selection**: Mark and navigate between selected log entries
- **Inspection**: Detailed YAML view of any log entry

## Installation

```bash
npm install -g uncloggr
# or
yarn global add uncloggr
```

## Usage

```bash
uncloggr [OPTIONS] [sources...]
```

### Options

- `-a, --all` - Include all sources (e.g., stopped Docker containers)
- `-f, --follow` - Follow log output (default: true)
- `--since <string>` - Show logs since timestamp (e.g., "2013-01-02T13:23:37Z") or relative (e.g., "42m")
- `-n, --tail <string>` - Number of lines to show from the end of logs
- `-s, --sort` - Sort logs by timestamp (slower but useful for multiple sources)
- `-h, --help` - Show help
- `-v, --version` - Show version

### Source Syntax

Sources can be specified with optional type prefixes:

- `pm2:<pattern>` - PM2 process matching pattern
- `docker:<pattern>` - Docker container matching pattern
- `docker-service:<pattern>` - Docker service matching pattern
- `file:<path>` - Log file at path
- `stdin:-` - Read from stdin
- `<pattern>` - Auto-detect source type

If no source is specified and stdin is not a TTY, reads from stdin. Otherwise, prompts for source selection.

### Examples

```bash
# View logs from a PM2 process
uncloggr pm2:api-server

# View logs from a Docker container
uncloggr docker:nginx

# View a log file
uncloggr file:/var/log/app.log

# Follow multiple sources with sorting
uncloggr --sort docker:api docker:worker

# Read from stdin
tail -f /var/log/app.log | uncloggr

# Show last 100 lines from all Docker containers
uncloggr --all --tail 100 docker:
```

### Reading Docker Logs Over SSH

If you often run this on remote servers using ssh, you can either install and run it on the remote host, or you can use `DOCKER_HOST` environment variable and run it locally.

When running it locally, it may take longer to load the log contents, but the user-interface will be less laggy.

```
DOCKER_HOST=ssh://root@myhost.com uncloggr <args>
```

To avoid typing this long command, you can add the following to your .bashrc (or similar):

```
u() {
  local host="$1"
  shift
  DOCKER_HOST="ssh://${host}" uncloggr "$@"
}
```

And you can now type `u root@myhost.com <args>` instead.

### Docker Service Logs

When using the `docker-service:` source, `docker service logs` is used to read logs. This is [sometimes buggy](https://github.com/moby/moby/issues/33183), causing it show incomplete logs. This is also why docker services are not suggested by default unless you specify `docker-service:`.

## Keyboard Shortcuts

### Navigation
- `j` or `↓` - Move down one line
- `k` or `↑` - Move up one line
- `Ctrl+d` or `PageDown` - Move down half page
- `Ctrl+u` or `PageUp` - Move up half page
- `h` or `←` - Select previous field
- `l` or `→` - Select next field
- `g` - Go to first line
- `G` - Go to last line
- `F` - Follow mode (jump to end)

### Filtering
- `1-6` - Filter by log level (1=TRACE, 2=DEBUG, 3=INFO, 4=WARN, 5=ERROR, 6=FATAL)
- `+` - Filter to entries where selected field equals current value
- `-` - Filter out entries where selected field equals current value
- `&` - Add custom text filter
- `=` - Add custom expression filter
- `Backspace` - Remove last filter
- `Meta+Backspace` - Clear all filters

### Search
- `/` - Search forward
- `n` - Next search result
- `N` - Previous search result

### Selection
- `Space` - Toggle selection on current line
- `m` - Jump to next selected line
- `M` - Jump to previous selected line
- `s` - Sort messages by timestamp

### Fields
- `*` - Add new field to display
- `\` - Remove selected field from display

### View
- `Enter` - Toggle detailed inspection view
- `c` - Clear all messages
- `q` - Quit

### In Inspection View
- `↑` or `↓` - Scroll inspection pane
- `Enter` or `Esc` - Exit inspection view

## Log Format

uncloggr works best with JSON-formatted logs, and is expected to be used with [pino](https://getpino.io/#/)/[bunyan](https://www.npmjs.com/package/bunyan). Each log entry should be a JSON object on a single line. Common fields:

- `time` - Timestamp (ISO 8601 format)
- `level` - Numeric log level (10=TRACE, 20=DEBUG, 30=INFO, 40=WARN, 50=ERROR, 60=FATAL)
- `name` - Logger name or component
- `msg` - Log message
- Any other custom fields

Non-JSON lines are treated as plain text messages with level 100 (INVALID).

### Example Log Entry

```json
{"time":"2025-10-30T12:34:56.789Z","level":30,"name":"api","msg":"Request received","method":"GET","path":"/users"}
```

## Development

```bash
# Install dependencies
yarn install

# Build
yarn build

# Watch mode for development
yarn dev
```

## License

ISC
