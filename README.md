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

> Status: early. This README is a stub. The full run instructions and feature
> walkthrough are finalized in later features (see `.agents/tasks` for the
> delivery plan). For architecture and the exact client/server contract, read
> `DESIGN.md`.

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
