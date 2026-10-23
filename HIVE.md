# HIVE

Status: DESIGN ONLY. Nothing in this document is implemented in the first
vertical slice. It describes the future "office of agents" / multi-agent
orchestration concept so later slices share a direction. Everything here is
subject to change.

Style note: no long dash characters are used in this document.

---

## Purpose

Turn the office from a set of independent agents into a coordinated team: a
main agent (the orchestrator) plans and delegates work to worker agents, tracks
their progress, and composes their results. The office metaphor makes this
legible: you literally watch the orchestrator hand tasks to agents at their
desks.

## Roles (draft)

- Orchestrator (main agent): owns the overall goal, breaks it into tasks, and
  assigns tasks to workers. It is the agent whose selection exposes the "Stop
  all work" control (see `SPEC.md`).
- Worker agents: execute assigned tasks, stream their output, and report
  completion or failure back to the orchestrator.

## Coordination model (draft)

- Task queue: the orchestrator produces tasks; workers claim and execute them.
- Status roll-up: worker lifecycle states (from the FSM in `DESIGN.md`) roll up
  so the orchestrator and the UI can show overall progress.
- Global controls: "Stop all work" (the existing `agent.stopAll`) halts the
  whole hive at once; the cambuk gag still applies per worker and remains a
  no-op.
- Backpressure: the orchestrator limits how many workers run at once to protect
  host resources.

## How it builds on the current slice

- Transport: the same WebSocket envelope from `DESIGN.md`; orchestration adds
  new message types (for example `task.assign`, `task.update`) rather than a new
  transport.
- Lifecycle: workers reuse the existing per-agent FSM and goroutine pair; the
  hive layer sits above the Manager and does not replace it.
- Memory: a shared memory graph (see `MEMORY_GRAPH_SPEC.md`) could let the
  orchestrator and workers share context.

## Open questions (to resolve in a later slice)

- Does the orchestrator run as a real agent CLI, or as daemon-side logic that
  drives worker CLIs.
- Task granularity and how results are merged.
- Failure handling: what happens to an assigned task when a worker crashes
  (circuit breaker trips) and whether it is reassigned.
- How delegation is visualized in the office scene (movement, hand-off
  animations) while keeping the UI friendly and uncluttered.
