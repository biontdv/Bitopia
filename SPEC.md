# SPEC

User-facing feature specification for the Agentic Virtual Office. This mirrors
the reference project (`HarnessMD/munder-difflin`) in feature spirit only, and
adds the explicit requests from the project brief. Each feature notes whether it
ships in the first vertical slice or is designed-only for a later slice.

Style note: no long dash characters are used in this document.

Legend:

- [Slice] = implemented in the first vertical slice (offline-demoable via the
  daemon + embedded fallback UI, and scaffolded in the production frontend).
- [Designed] = specified here and in DESIGN.md, implemented in a later slice.

---

## 1. Watch agents work in a 2D office

A friendly, approachable 2D office scene where each agent is an avatar
(sprite). The office shows rooms, furniture, and the company logo. Agents move
around and display a status speech bubble that reflects their current lifecycle
state (idle, starting, running, paused, stopping, stopped, crashed).

- [Slice] At least one agent sprite that moves and shows a status speech bubble,
  rendered on a Canvas in the fallback UI and with Pixi.js v8 in the production
  UI.
- [Slice] Rooms, furniture, and logo drawn from the office data model.

The visual style is deliberately friendlier and more approachable than the
reference, as explicitly requested.

## 2. Live terminal stream per agent

Each agent's output streams into a terminal panel in real time over the
WebSocket. In the production UI this is xterm.js with the WebGL addon so text
rendering is offloaded to the GPU when many agents stream at once; in the
fallback UI it is an auto-scrolling text panel with a capped line buffer.

- [Slice] Streaming output from a MOCK agent into the terminal panel, with
  auto-scroll and a capped buffer.
- [Slice] (Production) xterm.js + `@xterm/addon-webgl` wired up.

## 3. Code diff view

A Monaco-based diff view to show code an agent changed (original vs modified).

- [Slice] (Production) Monaco diff editor instantiated; diff content may be a
  placeholder/stub for the first slice.
- [Designed] Real per-agent diff feeding from agent file changes.

## 4. Monitoring view with per-agent Pause and Resume

A monitoring panel lists all agents with their current state and gives each
agent its own Pause and Resume buttons. Pause suspends the agent (SIGSTOP for a
real CLI, generator halt for MOCK); Resume continues it (SIGCONT / resume
generator).

- [Slice] Per-agent Pause and Resume buttons that send `agent.pause` /
  `agent.resume` and reflect the resulting `agent.state`.

## 5. Orchestrator / main-agent "Stop all work" control

When the orchestrator or main agent is selected, a single control stops all
agents at once ("Stop all work"). This maps to the `agent.stopAll` command.

- [Slice] A "Stop all work" button that sends `agent.stopAll` and stops every
  agent.

## 6. Cambuk (whip) gag

A playful "cambuk" (whip) button per agent. It is purely for fun and has NO
functional effect on the agent process: nothing starts, stops, pauses, or
changes in the real run. When an agent is whipped, its sprite plays a brief
reaction (for example a shake plus a surprised "!" or a sweat-drop expression)
and then returns to normal.

- [Slice] A per-agent cambuk button that sends `agent.whip`; the daemon emits a
  one-shot "whipped" side-channel event and the sprite plays a reaction with no
  change to run state. This is explicitly a no-op gag.

## 7. Office setup and customization (editable after creation)

A setup flow lets the user design the office and keep editing it afterward:

- Customize the room layout (position and size of rooms).
- Pick furniture (add, remove, and place items such as desks, plants,
  whiteboards, couches, each with a rotation).
- Upload the company logo.

Crucially, all of this remains editable after the office already exists, through
the same update path used at setup. The logo can be replaced at any time.

- [Slice] Office data model + persistence in the daemon; a minimal customize
  panel in the fallback UI to edit room layout, add/remove furniture, and upload
  a logo via `POST /api/logo`; changes call `office.update` and re-render.
- [Slice] (Production) A friendlier setup/customize view reachable both during
  setup and after the office exists.
- [Designed] Richer drag-and-drop layout editing and a furniture catalog with
  nicer art.

## 8. Multiple agent backends (mock / claude / codex / antigravity)

Agents are launched through pluggable adapters selected by config. The MOCK
adapter needs no real CLI and streams synthetic output, so the office is
demoable with nothing installed. The claude, codex, and antigravity adapters
drive the real CLIs under a PTY so their interactive TUIs render correctly.

- [Slice] MOCK adapter (default) streaming synthetic output; PTY-backed adapter
  that builds a config-driven argv for claude/codex/antigravity (the CLI only
  needs to exist on PATH at run time).
- [Designed] Per-CLI tuning (prompts, flags, environment presets) and richer
  per-adapter status parsing.

## 9. Idle agent behaviors (ambient office life)

When an agent has no task (for example its lifecycle state is `idle`, or it is
`running` but not actively producing output), its avatar does not just stand
still. It performs ambient "office life" behaviors to make the office feel
alive and friendly: relaxing on a sofa, playing billiard, chatting or
interacting with another nearby agent, making coffee at a coffee station, and
similar small idle activities. These behaviors are purely cosmetic and have no
effect on the agent's run state or output; the moment real work arrives the
avatar returns to its desk and resumes the normal status display.

- [Slice] A minimal idle behavior in the office scene: when an agent is idle it
  wanders to a furniture spot (for example the sofa or coffee station) and plays
  a simple idle animation instead of standing still. The fallback UI implements
  at least one such behavior; the production UI adds more variety.
- [Designed] A richer behavior system: a weighted pool of activities (sofa,
  billiard, coffee, agent-to-agent interaction, idle chatter bubbles), driven by
  nearby furniture types from the office data model, with smooth transitions
  back to work when a task starts. Behaviors are selected per agent so the
  office looks lively without being distracting, keeping the friendly tone.

This is cosmetic only: idle behaviors never change lifecycle state, never alter
output, and are independent of the cambuk gag (though a whip can interrupt an
idle animation with the same one-shot reaction).

## 10. Crash resilience (circuit breaker)

The daemon supervises each agent process and protects against crash-loops with
a circuit breaker and restart backoff, moving a repeatedly-failing agent to a
`crashed` state instead of spinning.

- [Slice] Circuit-breaker / crash-loop detection in the lifecycle Manager
  (exercised by tests).

## 11. Single-binary, offline-friendly distribution

The daemon embeds the UI and ships as one static binary that runs anywhere. The
offline fallback UI makes the slice demoable with no network and no package
installs.

- [Slice] `//go:embed` of the fallback UI into the daemon binary; documented
  offline build-and-run flow.

---

## Future / designed-only concepts

These are specified at a high level in their own documents and are NOT
implemented in the first slice:

- Agent memory / knowledge graph: see `MEMORY_GRAPH_SPEC.md`. [Designed]
- Multi-agent orchestration ("office of agents" / hive): see `HIVE.md`.
  [Designed]
