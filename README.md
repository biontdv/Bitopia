# Agentic Virtual Office

A browser-based "virtual office" where AI coding agents (Claude Code, Codex,
Antigravity, or a built-in MOCK agent) appear as little avatars working in a
customizable 2D office. You watch them work in real time: each agent has a
sprite with a status speech bubble, a live terminal stream of its output, and
a friendly control panel to pause, resume, or stop them. You can also give an
agent a playful "cambuk" (whip) to make it react, which is purely a gag and has
no effect on the real process.

This project is inspired, in feature spirit only, by
`HarnessMD/munder-difflin`. No code or text is copied from it.

For architecture and the exact client/server contract, read `DESIGN.md`.

## Quick start (offline, no npm)

The entire vertical slice runs offline with no package installs. The daemon uses
only the Go standard library, and the embedded fallback UI is compiled by the
globally available `tsc`.

### Prerequisites

- Go 1.25 or newer on your `PATH`.
- TypeScript's `tsc` on your `PATH` (any recent 5.x). Only used to rebuild the
  fallback UI; you can skip it because the compiled UI is committed.
- A modern browser.

No network access, `npm install`, `go get`, or bundler is required.

### Run it

```sh
# 1. (Optional) rebuild the embedded fallback UI. The compiled output is already
#    committed under daemon/web/dist, so you can skip this and jump to step 2.
./frontend-fallback/build.sh

# 2. Build the daemon. It embeds whatever is in daemon/web/dist via //go:embed.
cd daemon
go build -o bin/officed ./cmd/officed

# 3. Run it, then open http://localhost:8080 in your browser.
./bin/officed
```

Use `-addr` to change the listen address (default `:8080`) and `-data` to change
the data directory (default `./data`, which holds `office.json` and the uploaded
logo). For example: `./bin/officed -addr 127.0.0.1:8099 -data ./data`.

### What you will see

- A friendly 2D office scene on a Canvas: a room, furniture (desk, sofa,
  billiard table, coffee station), the company logo if you upload one, and one
  avatar per agent. Each avatar walks around, shows a status speech bubble that
  reflects its lifecycle state, and when it has no active task it wanders off to
  relax on the sofa, make coffee, or play billiard, then returns to its desk
  when work resumes (purely cosmetic).
- A terminal panel at the bottom streaming the agents' output live, capped to a
  bounded line buffer.
- A monitoring panel with per-agent Start / Pause / Resume / Stop buttons, an
  orchestrator "Stop all work" button, and a per-agent "Cambuk" (whip) button
  that plays a brief sprite reaction (a shake plus a surprised "!" and a sweat
  drop) with no effect on the agent's real run state.
- An "Office setup" tab to edit the room layout, add or remove furniture, and
  upload a company logo. It works both during initial setup and anytime after
  the office already exists; Save sends `office.update` and the scene re-renders.

Two MOCK agents are preconfigured, so the office is demoable with no real CLI
installed. Press "Start" on an agent to watch it stream synthetic output.

### Rebuilding the fallback UI

`frontend-fallback/build.sh` runs `tsc -p frontend-fallback/tsconfig.json`
(emitting ES2020 modules into `daemon/web/dist`) and copies `index.html` and
`styles.css` alongside them. After rebuilding the UI, rebuild the daemon so the
`//go:embed` picks up the new files. The committed build output means a fresh
checkout runs with just steps 2 and 3 above.

## What it is

- A single Go daemon (the "host daemon") that serves the UI, runs agents behind
  a pseudo-terminal (PTY), and streams their output to the browser over
  WebSocket.
- A browser UI that renders the office, the agents, and a terminal, and sends
  control commands back to the daemon.

## Documentation

- `DESIGN.md` - architecture, WebSocket protocol, agent lifecycle, adapter
  interface, office data model, and the single-binary distribution approach.
- `SPEC.md` - the user-facing features and which ones ship in the first
  vertical slice.
- `MEMORY_GRAPH_SPEC.md` - forward-looking design for agent memory (design only).
- `HIVE.md` - forward-looking design for multi-agent orchestration (design only).

## Repository layout

```
.
├── DESIGN.md              # architecture + contracts
├── SPEC.md                # feature spec
├── MEMORY_GRAPH_SPEC.md   # future: agent memory graph (design only)
├── HIVE.md                # future: multi-agent orchestration (design only)
├── README.md              # this file
├── daemon/                # Go daemon (stdlib only), added in a later feature
├── frontend/              # production React + TS + Vite + Pixi + xterm + Monaco
└── frontend-fallback/     # dependency-free vanilla-TS demo UI (offline demo)
```

## Why two frontends?

The build sandbox blocks all external package registries and CDNs. The
production React/Pixi/xterm/Monaco frontend is scaffolded to build on a machine
with network access, while a dependency-free vanilla-TypeScript fallback UI
(compiled by the global `tsc`, no bundler, no npm) is embedded into the daemon
so the whole office is demoable offline. See `DESIGN.md` for the full rationale.

## License

TBD.
