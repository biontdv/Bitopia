// Zustand VANILLA store. The WebSocket layer writes into this store with
// store.setState(...) OUTSIDE React's render cycle, which is the user's explicit
// requirement: high-frequency agent.output / agent.state traffic must not
// trigger a React render per message or the office scene stutters. React
// components subscribe to narrow slices via the useStore hook (see hooks.ts),
// and the Pixi scene reads store.getState() every animation frame without any
// React involvement at all.
//
// The store holds protocol-level truth (agents, office, connection, errors) plus
// an append-only ring of output buffers per agent for the terminal. Purely
// cosmetic animation bookkeeping (sprite position, idle behavior, whip timer)
// lives in the Pixi scene, not here, so that scene churn never notifies React.

import { createStore } from "zustand/vanilla";
import type { AgentState, Office, ListEntry, StatePayload } from "../ws/protocol";

// Maximum characters retained per agent output buffer so memory stays bounded
// during long sessions. The terminal component also caps its own scrollback.
const MAX_BUFFER_CHARS = 200_000;

// AgentView is the UI-facing model of one agent: protocol lifecycle fields plus
// a lastOutputTs the scene uses to decide whether a running agent is
// effectively idle (no recent output) and may wander off for ambient behavior.
export interface AgentView {
  id: string;
  displayName: string;
  adapter: string;
  state: AgentState;
  pid: number;
  restarts: number;
  lastOutputTs: number;
  // whipSeq increments on each whip event; the scene watches it to fire a
  // one-shot reaction without the store tracking animation timers.
  whipSeq: number;
}

export interface StoreState {
  connected: boolean;
  agents: Record<string, AgentView>;
  order: string[];
  office: Office | null;
  lastError: string;
  // Per-agent output buffer (raw text, may contain ANSI). The terminal reads
  // the selected agent's buffer; a bump counter lets the terminal cheaply
  // detect new data per agent.
  output: Record<string, string>;
  outputSeq: Record<string, number>;
  // The agent whose terminal + diff are currently shown in the UI.
  selectedAgentId: string | null;

  // Actions (called by the WS layer and the UI).
  setConnected: (v: boolean) => void;
  setError: (msg: string) => void;
  setOffice: (o: Office) => void;
  upsertFromList: (entries: ListEntry[]) => void;
  applyState: (id: string, p: StatePayload) => void;
  appendOutput: (id: string, data: string) => void;
  selectAgent: (id: string) => void;
}

function newAgent(id: string, displayName: string, adapter: string, state: AgentState): AgentView {
  return {
    id,
    displayName,
    adapter,
    state,
    pid: 0,
    restarts: 0,
    lastOutputTs: 0,
    whipSeq: 0,
  };
}

export const officeStore = createStore<StoreState>((set, get) => ({
  connected: false,
  agents: {},
  order: [],
  office: null,
  lastError: "",
  output: {},
  outputSeq: {},
  selectedAgentId: null,

  setConnected: (v) => set({ connected: v }),

  setError: (msg) => set({ lastError: msg }),

  setOffice: (o) => set({ office: o }),

  upsertFromList: (entries) => {
    const prev = get().agents;
    const next: Record<string, AgentView> = {};
    const order: string[] = [];
    for (const e of entries) {
      order.push(e.id);
      const existing = prev[e.id];
      next[e.id] = existing
        ? { ...existing, displayName: e.displayName, adapter: e.adapter, state: e.state }
        : newAgent(e.id, e.displayName, e.adapter, e.state);
    }
    const selected = get().selectedAgentId;
    const nextSelected = selected && next[selected] ? selected : order[0] ?? null;
    set({ agents: next, order, selectedAgentId: nextSelected });
  },

  applyState: (id, p) => {
    const prev = get().agents;
    const existing = prev[id];
    // A whip is a one-shot cosmetic flag: bump whipSeq and do NOT change the
    // lifecycle state (DESIGN.md section 2.3).
    if (p.whipped) {
      const base = existing ?? newAgent(id, p.displayName, p.adapter, p.state);
      set({ agents: { ...prev, [id]: { ...base, whipSeq: base.whipSeq + 1 } } });
      return;
    }
    const base = existing ?? newAgent(id, p.displayName, p.adapter, p.state);
    const updated: AgentView = {
      ...base,
      displayName: p.displayName,
      adapter: p.adapter,
      state: p.state,
      pid: p.pid,
      restarts: p.restarts,
    };
    const order = get().order.includes(id) ? get().order : [...get().order, id];
    const selectedAgentId = get().selectedAgentId ?? id;
    set({ agents: { ...prev, [id]: updated }, order, selectedAgentId });
  },

  appendOutput: (id, data) => {
    const prevOut = get().output;
    const prevSeq = get().outputSeq;
    let buf = (prevOut[id] ?? "") + data;
    if (buf.length > MAX_BUFFER_CHARS) {
      buf = buf.slice(buf.length - MAX_BUFFER_CHARS);
    }
    // Mark the agent as having produced output recently so the scene knows it
    // is actively working (and should stay at its desk rather than wander).
    const prevAgents = get().agents;
    const a = prevAgents[id];
    const agents = a ? { ...prevAgents, [id]: { ...a, lastOutputTs: Date.now() } } : prevAgents;
    set({
      output: { ...prevOut, [id]: buf },
      outputSeq: { ...prevSeq, [id]: (prevSeq[id] ?? 0) + 1 },
      agents,
    });
  },

  selectAgent: (id) => set({ selectedAgentId: id }),
}));

export type OfficeStore = typeof officeStore;
