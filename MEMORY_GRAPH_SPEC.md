# MEMORY_GRAPH_SPEC

Status: DESIGN ONLY. Nothing in this document is implemented in the first
vertical slice. It is a forward-looking sketch so later slices have a shared
starting point. Everything here is subject to change.

Style note: no long dash characters are used in this document.

---

## Purpose

Give agents a persistent, queryable memory so they can recall prior work,
decisions, and facts across sessions, rather than starting cold every run. The
memory is modeled as a knowledge graph: nodes for entities and edges for
relationships, with provenance pointing back to the agent, task, and timestamp
that produced each fact.

## Why a graph

Agent work is relational: a task touches files, files belong to a module, a
decision references a requirement, an error relates to a prior fix. A graph
captures those relationships directly and supports "how did we get here"
queries that a flat log cannot answer well.

## Core concepts (draft)

- Node: an entity with a stable id, a type (for example `task`, `file`,
  `decision`, `fact`, `agent`), and a small property bag.
- Edge: a typed, directed relationship between two nodes (for example
  `agent --produced--> decision`, `decision --about--> file`).
- Provenance: every node and edge records which agent/run/timestamp created it,
  so memory can be audited and expired.
- Scope: memory may be scoped per office, per agent, or shared, to control what
  one agent can see of another's work.

## Sketch of a node and edge (draft JSON)

```json
{
  "node": {
    "id": "fact-42",
    "type": "fact",
    "props": { "text": "The build target is Go 1.25." },
    "provenance": { "agentId": "agent-1", "runId": "run-7", "ts": 1736500000000 }
  },
  "edge": {
    "id": "edge-9",
    "from": "agent-1",
    "to": "fact-42",
    "type": "produced",
    "provenance": { "runId": "run-7", "ts": 1736500000000 }
  }
}
```

## Open questions (to resolve in a later slice)

- Storage: embedded key-value store vs an external graph database. The daemon's
  stdlib-only / offline constraint suggests starting with a simple on-disk JSON
  or an embedded store rather than a networked DB.
- Retrieval: exact-match and graph traversal first; semantic/vector search is a
  later addition and must respect the offline constraint.
- Memory lifecycle: expiry, summarization/compaction, and conflict handling when
  two agents record contradicting facts.
- Privacy and scope rules between agents sharing one office.

## Relationship to the rest of the system

When implemented, the memory graph would be another concern owned by the
daemon, surfaced to the UI through additional WebSocket message types that
follow the same envelope defined in `DESIGN.md`. No new transport is needed.
