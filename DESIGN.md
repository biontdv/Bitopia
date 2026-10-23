# DESIGN

Architecture and contracts for the Agentic Virtual Office. This document is the
authoritative contract that the daemon and both frontends implement against:
the WebSocket message protocol, the agent lifecycle state machine, the agent
adapter interface, and the office customization data model. It also documents
the single-binary distribution approach and the sandbox network constraint that
shapes the whole build.

Style note: this project does not use the long dash character anywhere in its
docs. Plain hyphens are used instead.

---

## 1. System overview

The system has two processes:

1. A single Go "host daemon" (`officed`) that:
   - serves the browser UI over HTTP,
   - exposes a WebSocket endpoint for live, bidirectional messaging,
   - spawns and supervises agent CLIs (Claude Code, Codex, Antigravity) behind
     a pseudo-terminal (PTY), or runs a built-in MOCK agent that needs no PTY,
   - owns the office customization data model and persists it to disk.

2. The browser UI, which renders the 2D office (agents, rooms, furniture, logo)
   and the terminal stream, and sends control commands back to the daemon.

```
  +-------------------- Browser tab --------------------+
  |  Office scene (Pixi.js / Canvas)                    |
  |  Terminal panel (xterm.js / <pre>)                  |
  |  Monitoring + controls (pause/resume/stop/whip)     |
  |  Office setup (layout, furniture, logo upload)      |
  +------------------------^----------------------------+
             HTTP (GET /, /api/logo) |  WebSocket (/ws)
                                     v
  +-------------------- Go daemon (officed) ------------+
  |  HTTP server + static file server (//go:embed)      |
  |  WebSocket hub  (stdlib: Hijack + sha1 + base64)    |
  |  Agent lifecycle Manager                            |
  |     per agent: [reader goroutine] [monitor goroutine]|
  |  Agent adapters: mock | claude | codex | antigravity |
  |  Office store (JSON on disk)                         |
  +------------------------^----------------------------+
                           | PTY master (/dev/ptmx) or
                           | MOCK generator channel
                           v
  +------ agent process (claude / codex / antigravity) -+
  |  interactive TUI over a real TTY                    |
  +-----------------------------------------------------+
```

Data flow in one sentence: the browser sends typed JSON commands over the
WebSocket, the daemon drives the agent processes and the office store, and the
daemon streams typed JSON events (agent output, state changes, office state)
back to every connected browser.

---

## 2. WebSocket message protocol

All messages share one JSON envelope. The envelope is intentionally small and
uniform so the frontend can route on a single `type` field and keep ordering
with `seq`.

### 2.1 Envelope

```json
{
  "type": "agent.output",
  "agentId": "agent-1",
  "seq": 42,
  "ts": 1736500000000,
  "payload": { }
}
```

Field semantics:

- `type` (string, required): the message type, dotted namespace (for example
  `agent.start`, `office.state`).
- `agentId` (string, optional): the target or source agent id. Empty or absent
  for messages that are not scoped to one agent (for example `agent.stopAll`,
  `office.get`, `error`).
- `seq` (uint64): a monotonically increasing sequence number. Server->client
  streams use a per-agent (or per-hub) incrementing counter so the UI can
  detect gaps and preserve ordering. Client->server messages may send `0`.
- `ts` (int64): Unix time in milliseconds when the message was produced.
- `payload` (object): type-specific body. May be omitted when empty.

Go definition (implemented in the daemon's `ws` package):

```go
type Envelope struct {
    Type    string          `json:"type"`
    AgentID string          `json:"agentId,omitempty"`
    Seq     uint64          `json:"seq"`
    Ts      int64           `json:"ts"`
    Payload json.RawMessage `json:"payload,omitempty"`
}
```

### 2.2 Client to server messages

These are commands the browser sends. The daemon validates each, applies it to
the Manager or office store, and then broadcasts the resulting server->client
event(s).

#### `agent.start`

Start (or launch) a configured agent.

```json
{
  "type": "agent.start",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": { "adapter": "mock" }
}
```

`payload.adapter` is optional; if omitted the daemon uses the agent's
configured adapter kind (defaulting to `mock`).

#### `agent.pause`

Pause a running agent. For PTY agents this stops the process group with
`SIGSTOP`; for the MOCK agent it stops the output generator.

```json
{
  "type": "agent.pause",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {}
}
```

#### `agent.resume`

Resume a paused agent (`SIGCONT` for PTY agents, resume generator for MOCK).

```json
{
  "type": "agent.resume",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {}
}
```

#### `agent.stop`

Stop a single agent. The daemon sends `SIGTERM`, then `SIGKILL` after a grace
timeout.

```json
{
  "type": "agent.stop",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": { "graceMs": 3000 }
}
```

`payload.graceMs` is optional and overrides the default grace period.

#### `agent.stopAll`

The orchestrator / main-agent "Stop all work" control. Stops every agent.

```json
{
  "type": "agent.stopAll",
  "agentId": "",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {}
}
```

#### `agent.whip`

The cambuk (whip) gag. This has NO functional effect on the agent process. It
exists purely for fun: the daemon emits a side-channel event so the UI can play
a brief reaction animation on the whipped agent's sprite.

```json
{
  "type": "agent.whip",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {}
}
```

#### `office.get`

Request the current office customization state.

```json
{
  "type": "office.get",
  "agentId": "",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {}
}
```

#### `office.update`

Update the office layout, furniture, name, or logo reference. The payload is a
full or partial Office object (see section 5). The daemon persists it and
broadcasts `office.state`.

```json
{
  "type": "office.update",
  "agentId": "",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {
    "name": "Second Floor",
    "rooms": [
      { "id": "room-1", "name": "Engineering", "x": 0, "y": 0, "w": 800, "h": 480 }
    ],
    "furniture": [
      { "id": "f-1", "type": "desk", "roomId": "room-1", "x": 80, "y": 80, "rotation": 0 }
    ]
  }
}
```

Note on the logo: the raw image is uploaded over HTTP (`POST /api/logo`, a
multipart file) because binary blobs do not belong in the JSON WebSocket
stream. That endpoint stores the file and sets `logoRef`; the daemon then
broadcasts `office.state` so all clients re-render. `logoRef` is owned by the
upload endpoint: a `logoRef` sent in an `office.update` patch is ignored so the
reference can never disagree with the image bytes GET serves.

### 2.3 Server to client messages

These are events the daemon broadcasts to connected browsers.

#### `agent.state`

An agent changed state (see the FSM in section 3). Sent on every transition.

```json
{
  "type": "agent.state",
  "agentId": "agent-1",
  "seq": 7,
  "ts": 1736500000050,
  "payload": {
    "state": "running",
    "adapter": "mock",
    "displayName": "Mock Agent 1",
    "pid": 12345,
    "restarts": 0,
    "whipped": false
  }
}
```

When a whip arrives, the daemon emits an `agent.state` with `"whipped": true`
(a one-shot flag the UI animates) followed immediately by the normal state with
`"whipped": false`. The run state does not change.

#### `agent.output`

A chunk or line of agent output (from the PTY master or the MOCK generator).

```json
{
  "type": "agent.output",
  "agentId": "agent-1",
  "seq": 128,
  "ts": 1736500000120,
  "payload": {
    "stream": "stdout",
    "data": "build: compiling module 7/20...\n"
  }
}
```

`payload.stream` is `stdout` or `stderr`. `payload.data` is a raw UTF-8 string
(it may contain ANSI escape sequences, which xterm.js renders). The UI caps its
buffer to avoid unbounded memory growth.

#### `agent.list`

The full set of known agents and their current state. Sent on connect and
whenever the roster changes.

```json
{
  "type": "agent.list",
  "agentId": "",
  "seq": 1,
  "ts": 1736500000000,
  "payload": {
    "agents": [
      { "id": "agent-1", "displayName": "Mock Agent 1", "adapter": "mock", "state": "running" },
      { "id": "agent-2", "displayName": "Claude", "adapter": "claude", "state": "idle" }
    ]
  }
}
```

#### `office.state`

The current office customization state (full Office object, section 5). Sent in
response to `office.get`, after any `office.update`, and after a logo upload.

```json
{
  "type": "office.state",
  "agentId": "",
  "seq": 3,
  "ts": 1736500000000,
  "payload": {
    "id": "office-1",
    "name": "HQ",
    "logoRef": "/api/logo?v=3",
    "rooms": [
      { "id": "room-1", "name": "Engineering", "x": 0, "y": 0, "w": 800, "h": 480 }
    ],
    "furniture": [
      { "id": "f-1", "type": "desk", "roomId": "room-1", "x": 80, "y": 80, "rotation": 0 }
    ]
  }
}
```

#### `error`

A problem processing a client message (bad JSON, unknown agent, invalid
transition, oversized logo, and so on).

```json
{
  "type": "error",
  "agentId": "agent-1",
  "seq": 0,
  "ts": 1736500000000,
  "payload": {
    "code": "invalid_transition",
    "message": "cannot pause an agent in state 'stopped'"
  }
}
```

Error codes used by the daemon include: `bad_request`, `unknown_type`,
`unknown_agent`, `invalid_transition`, `logo_too_large`, `logo_bad_type`,
`internal`.

---

## 3. Agent lifecycle FSM

Every agent is a small state machine owned by the lifecycle Manager. Each state
change broadcasts an `agent.state` envelope.

### 3.1 States

- `idle`: known/configured but not started.
- `starting`: adapter command is being launched (PTY opened or MOCK generator
  spun up).
- `running`: actively producing output.
- `paused`: suspended (`SIGSTOP` for PTY, generator halted for MOCK). Still
  alive, can resume.
- `stopping`: a stop was requested; waiting for the process to exit (SIGTERM,
  then SIGKILL after grace).
- `stopped`: terminated cleanly or by request. Terminal state (can be started
  again, which returns it to `starting`).
- `crashed`: the process exited unexpectedly and the circuit breaker tripped
  (crash-loop). Terminal state until an explicit restart.

### 3.2 Transitions

| From       | To         | Trigger                                              |
|------------|------------|------------------------------------------------------|
| idle       | starting   | `agent.start`                                        |
| stopped    | starting   | `agent.start` (restart)                              |
| crashed    | starting   | `agent.start` (explicit restart, resets breaker)     |
| starting   | running    | adapter launched, first output / process up          |
| starting   | crashed    | launch failed or immediate exit (breaker trips)      |
| running    | paused     | `agent.pause`                                        |
| paused     | running    | `agent.resume`                                       |
| running    | stopping   | `agent.stop` or `agent.stopAll`                      |
| paused     | stopping   | `agent.stop` or `agent.stopAll`                      |
| stopping   | stopped    | process exited within grace (or after SIGKILL)       |
| running    | crashed    | unexpected exit and crash-loop breaker trips         |
| paused     | crashed    | process died while suspended and breaker trips       |

Illegal transitions (for example `agent.pause` on a `stopped` agent) produce an
`error` envelope with code `invalid_transition` and do not change state.

```
            agent.start
   idle ---------------------> starting
    ^                             |  launched
    |                             v
    |  (start)                 running  <----- agent.resume -----+
    |                           |  |  ^                           |
 stopped <--- stopping <--------+  |  |  agent.pause              |
    ^            ^   stop/stopAll  |  +--------------------> paused
    |            |                 |                           |
  (start)        +-----------------+---- stop/stopAll ---------+
    |                                                           |
  crashed <--- unexpected exit + breaker trips (from running/paused/starting)
```

### 3.3 Goroutine pair per agent

When an agent starts, the Manager launches exactly two goroutines:

1. Reader goroutine: reads output from the MOCK generator channel OR from the
   PTY master file, wraps each chunk in an `agent.output` envelope with an
   incrementing `seq`, and hands it to the WebSocket hub for broadcast. It exits
   when the source closes (process exit or stop).

2. Monitor / circuit-breaker goroutine: waits on process exit (or MOCK done),
   handles pause/resume/stop control signals, and detects crash-loops. It is
   the only goroutine that drives state transitions, so transitions are
   serialized and race-free.

### 3.4 Circuit breaker (restart backoff / crash-loop detection)

The monitor tracks restarts within a sliding window (for example N restarts in
M seconds). If a process keeps exiting unexpectedly faster than the backoff
allows, the breaker trips and the agent moves to `crashed` instead of being
restarted, so a broken CLI cannot spin in a tight fork loop. Backoff grows
between restart attempts (for example exponential with a cap). An explicit
`agent.start` on a `crashed` agent resets the breaker counters.

The MOCK adapter does not fork a process, so it never trips the breaker in
normal operation; the breaker logic is exercised by tests that simulate
immediate exits.

---

## 4. Agent adapter interface

Adapters decouple "how to launch a given CLI" from the lifecycle Manager. The
Manager only knows the interface; concrete adapters know the argv/env for each
tool.

```go
// AdapterConfig is the per-agent configuration an adapter needs to build its
// launch command. It comes from the daemon config (see daemon/internal/config).
type AdapterConfig struct {
    ID          string            // agent id, e.g. "agent-1"
    DisplayName string            // human label shown in the UI
    Argv        []string          // configured command + args, e.g. ["claude"]
    Env         map[string]string // extra environment variables
    WorkDir     string            // working directory for the process
}

// AgentAdapter is the pluggable contract for launching an agent.
type AgentAdapter interface {
    // Name returns the adapter kind: "mock", "claude", "codex", or "antigravity".
    Name() string

    // BuildCommand produces the argv and environment used to launch the agent.
    // For the MOCK adapter this may return a sentinel (it does not exec a real
    // process); for PTY adapters it returns the resolved command line.
    BuildCommand(cfg AdapterConfig) (argv []string, env []string, err error)

    // SupportsPTY reports whether the adapter must run under a pseudo-terminal.
    // mock => false (uses a synthetic generator); claude/codex/antigravity => true.
    SupportsPTY() bool
}
```

### 4.1 Config-driven selection

A factory selects the adapter by kind:

```go
// NewAdapter returns the adapter for the given kind, defaulting to "mock" for
// an empty or unknown kind.
func NewAdapter(kind string, cfg AdapterConfig) (AgentAdapter, error)
```

Supported kinds:

- `mock` (default, always available): streams synthetic timestamped TUI/log
  lines, including periodic fake "progress" lines, with no PTY and no external
  process. This makes the whole office demoable with no real CLI installed and
  is what the offline slice uses.
- `claude`: launches the Claude Code CLI under a PTY (argv like `["claude"]`
  plus configured args).
- `codex`: launches the Codex CLI under a PTY.
- `antigravity`: launches the Antigravity CLI under a PTY.

The PTY-backed adapters build a config-driven argv so the specific command and
flags come from config, not from hardcoded assumptions. The real CLI only needs
to exist on the user's PATH at run time, not at build time.

### 4.2 PTY primitive (Linux, stdlib only)

The PTY-backed adapters run their process under a pseudo-terminal implemented
with the Go standard library only (no `creack/pty`):

1. open `/dev/ptmx` to get the master,
2. `ioctl(TIOCSPTLCK, 0)` to unlock the slave,
3. `ioctl(TIOCGPTN)` to get the slave number and derive `/dev/pts/N`,
4. open the slave, set it as the child's stdin/stdout/stderr, and start the
   process with `SysProcAttr{Setsid: true, Setctty: true}`.

The master `*os.File` is read by the reader goroutine. A non-Linux stub returns
an "unsupported" error so the module still compiles cross-platform. This exact
approach was verified working on the sandbox kernel.

---

## 5. Office customization data model

The office is a JSON document owned by the daemon, created in a setup flow and
editable at any time afterward. It is persisted to a JSON file under the data
directory (default `./data/office.json`).

### 5.1 Schema

```json
{
  "id": "office-1",
  "name": "HQ",
  "logoRef": "/api/logo?v=3",
  "rooms": [
    { "id": "room-1", "name": "Engineering", "x": 0, "y": 0, "w": 800, "h": 480 }
  ],
  "furniture": [
    { "id": "f-1", "type": "desk", "roomId": "room-1", "x": 80, "y": 80, "rotation": 0 }
  ]
}
```

Go definition (implemented in `daemon/internal/office`):

```go
type Office struct {
    ID        string      `json:"id"`
    Name      string      `json:"name"`
    LogoRef   string      `json:"logoRef,omitempty"`
    Rooms     []Room      `json:"rooms"`
    Furniture []Furniture `json:"furniture"`
}

type Room struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    X    int    `json:"x"`
    Y    int    `json:"y"`
    W    int    `json:"w"`
    H    int    `json:"h"`
}

type Furniture struct {
    ID       string `json:"id"`
    Type     string `json:"type"`     // e.g. "desk", "plant", "whiteboard", "couch", "sofa", "billiard", "coffee"
    RoomID   string `json:"roomId"`
    X        int    `json:"x"`
    Y        int    `json:"y"`
    Rotation int    `json:"rotation"` // degrees: 0, 90, 180, 270
}
```

Coordinates are in office-scene pixels. Room `x,y` is the top-left corner;
furniture `x,y` is positioned relative to the scene (with `roomId` recording
which room it belongs to for grouping and validation).

### 5.2 Lifecycle and persistence

- On first run the daemon creates a sensible default office: one room, a couple
  of furniture items, and no logo.
- The setup flow in the UI writes the initial layout via `office.update`.
- The same `office.update` path is used after the office exists, so layout,
  furniture, name, and logo are all editable at any time. There is no separate
  "setup only" write path; setup and later edits are the same operation.
- `Store.Get()` returns the current office; `Store.Update(o)` validates,
  writes `office.json` atomically (write temp then rename), and returns the
  stored value so the daemon can broadcast `office.state`.

### 5.3 Logo upload

The company logo is a binary image and is uploaded over HTTP, not the
WebSocket:

- `POST /api/logo` (multipart form, field `logo`): the daemon validates the
  content type is an image and that the size is within a cap, stores the file
  under the data directory, sets `Office.LogoRef`, and broadcasts
  `office.state`.
- `GET /api/logo`: serves the stored logo image.

The logo can be set during setup and replaced later, exactly like the rest of
the office.

### 5.4 Idle behaviors and furniture

Some furniture types double as idle-behavior anchors for the ambient office-life
feature described in `SPEC.md`. When an agent has no active task, the UI may
route its avatar to a nearby furniture item and play a cosmetic idle animation:
`sofa`/`couch` for relaxing, `billiard` for a quick game, `coffee` for the
coffee station, and so on. This is a pure UI concern driven by the furniture
`type` values in the office data model; it never changes agent lifecycle state
or output, and the daemon is not involved beyond serving the office data.

---

## 6. Single-binary distribution via `//go:embed`

The daemon ships as one self-contained binary. The compiled frontend is baked
in with `//go:embed`:

```go
// daemon/web/embed.go
package web

import (
    "embed"
    "io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded UI file system rooted at dist/.
func FS() (fs.FS, error) {
    return fs.Sub(distFS, "dist")
}
```

The daemon mounts an `http.FileServer` over this embedded FS at `/`, with an
`index.html` fallback for client-side routes.

Build and embed flow:

- Offline / sandbox demo (dependency-free fallback UI):
  1. `tsc -p frontend-fallback/tsconfig.json` compiles the vanilla-TS UI, with
     `outDir` set to `daemon/web/dist`, and `index.html` + `styles.css` are
     copied alongside it.
  2. `cd daemon && go build -o bin/officed ./cmd/officed` embeds whatever is in
     `daemon/web/dist`.
  A committed placeholder `daemon/web/dist/index.html` keeps the package
  compiling even before the UI is built.

- Production (full React/Pixi/xterm/Monaco UI, networked machine):
  1. `cd frontend && npm install && npm run build` produces `frontend/dist`.
  2. copy `frontend/dist` into `daemon/web/dist`.
  3. rebuild the daemon so the embed picks it up.

The result is a ~15-20 MB static binary that runs anywhere (Docker, a VM
sandbox, a laptop) with no external runtime dependencies.

---

## 7. Sandbox network constraint and the two-frontend approach

The build sandbox has a transparent allowlist proxy that returns HTTP 403 for
every external package registry and CDN: `registry.npmjs.org`,
`proxy.golang.org` (and `goproxy.io` / `goproxy.cn`), direct `github.com`
module fetches, and `jsdelivr` / `unpkg` / `esm.sh` / `cdnjs`. Consequences,
which are baked into the architecture on purpose:

1. The Go daemon uses ONLY the standard library. There is no `go get`, so there
   are no third-party modules: the WebSocket server is implemented with
   `net/http` `Hijack()` plus `crypto/sha1` and `encoding/base64` for the
   handshake and a hand-written RFC 6455 frame codec; the PTY is implemented
   with `/dev/ptmx` and `syscall` ioctls. No `gorilla/websocket`, no
   `creack/pty`.

2. There are TWO frontends, and both are intentional:
   - `frontend/`: the production React + TypeScript + Vite + Pixi.js (v8) +
     xterm.js + Monaco UI the user asked for. It requires `npm install`, so it
     builds on a machine with network access (the orchestrator pushes there).
   - `frontend-fallback/`: a dependency-free vanilla-TypeScript UI compiled by
     the globally available `tsc` (no bundler, no npm, DOM lib only). It is
     embedded via `//go:embed` so the entire vertical slice is runnable and
     demoable offline, inside this sandbox, with no package installs.

   Both frontends speak the exact same WebSocket protocol defined in section 2,
   so they are interchangeable from the daemon's point of view. The fallback UI
   proves the slice end to end offline; the production UI delivers the full,
   friendly experience once dependencies are installed.

Because `npm install` cannot run offline, a Docker build of the production
frontend is not possible in the sandbox and is skipped there; it runs on the
networked machine instead.
