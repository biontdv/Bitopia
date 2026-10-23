// A tiny framework-free state store: a plain object plus a set of listeners.
// It mirrors the "Zustand-outside-React" pattern so high-frequency WebSocket
// updates can mutate state and notify subscribers without going through any
// framework render loop. The Canvas scene reads this state every animation
// frame; the DOM panels subscribe and re-render on change.

import type { AgentState, Office } from "./protocol.js";

// AgentView is the UI-facing model of a single agent. It carries lifecycle
// fields from the protocol plus purely-cosmetic animation bookkeeping that the
// Canvas scene owns (position, target, idle behavior, whip reaction timer).
export interface AgentView {
  id: string;
  displayName: string;
  adapter: string;
  state: AgentState;
  pid: number;
  restarts: number;

  // Last time an agent.output line arrived (ms). Used to decide if a running
  // agent is effectively idle (no recent output) so its avatar can wander.
  lastOutputTs: number;

  // Cosmetic animation fields (owned by the scene, never sent to the server).
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  targetX: number;
  targetY: number;
  // idleUntil: while now < idleUntil the avatar lingers at an idle spot.
  idleUntil: number;
  // idleKind: which ambient behavior is playing ("", "sofa", "coffee", "billiard", "social").
  idleKind: string;
  // whipUntil: while now < whipUntil the avatar plays the whip reaction.
  whipUntil: number;
  // facing: -1 left, 1 right, used to flip the sprite.
  facing: number;
  // bob phase for a gentle idle bob.
  bob: number;
}

// StoreState is the whole UI state tree.
export interface StoreState {
  connected: boolean;
  agents: Record<string, AgentView>;
  order: string[];
  office: Office | null;
  lastError: string;
}

type Listener = () => void;

// Store holds the plain state object and notifies listeners on change. Mutations
// go through small action methods so the scene and panels stay consistent.
export class Store {
  private state: StoreState = {
    connected: false,
    agents: {},
    order: [],
    office: null,
    lastError: "",
  };

  private listeners = new Set<Listener>();

  // get returns the live state object. Readers must treat it as read-only.
  get(): StoreState {
    return this.state;
  }

  // subscribe registers a listener and returns an unsubscribe function.
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // notify runs every listener. Called after a batch of mutations.
  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  setConnected(v: boolean): void {
    this.state.connected = v;
    this.notify();
  }

  setError(msg: string): void {
    this.state.lastError = msg;
    this.notify();
  }

  setOffice(o: Office): void {
    this.state.office = o;
    // Re-anchor agent home desks against the first room so avatars start sensibly.
    this.anchorHomes();
    this.notify();
  }

  // upsertFromList replaces the roster from an agent.list payload, preserving
  // cosmetic animation fields for agents that already exist.
  upsertFromList(entries: { id: string; displayName: string; adapter: string; state: AgentState }[]): void {
    const order: string[] = [];
    for (const e of entries) {
      order.push(e.id);
      const existing = this.state.agents[e.id];
      if (existing) {
        existing.displayName = e.displayName;
        existing.adapter = e.adapter;
        existing.state = e.state;
      } else {
        this.state.agents[e.id] = this.newAgent(e.id, e.displayName, e.adapter, e.state);
      }
    }
    // Drop agents no longer present.
    for (const id of Object.keys(this.state.agents)) {
      if (!order.includes(id)) {
        delete this.state.agents[id];
      }
    }
    this.state.order = order;
    this.anchorHomes();
    this.notify();
  }

  // applyState updates one agent from an agent.state payload. whipped triggers
  // the cosmetic reaction only; it never changes the run state.
  applyState(
    id: string,
    p: { state: AgentState; adapter: string; displayName: string; pid: number; restarts: number; whipped: boolean }
  ): void {
    let a = this.state.agents[id];
    if (!a) {
      a = this.newAgent(id, p.displayName, p.adapter, p.state);
      this.state.agents[id] = a;
      if (!this.state.order.includes(id)) {
        this.state.order.push(id);
      }
      this.anchorHomes();
    }
    if (p.whipped) {
      // One-shot gag: play a brief reaction, do not touch lifecycle state.
      a.whipUntil = Date.now() + 900;
      a.idleUntil = 0;
      a.idleKind = "";
      this.notify();
      return;
    }
    a.displayName = p.displayName;
    a.adapter = p.adapter;
    a.state = p.state;
    a.pid = p.pid;
    a.restarts = p.restarts;
    this.notify();
  }

  // noteOutput records that an agent produced output recently (so a running
  // agent with no recent output can be treated as idle for ambient behaviors).
  noteOutput(id: string): void {
    const a = this.state.agents[id];
    if (a) {
      a.lastOutputTs = Date.now();
    }
  }

  private newAgent(id: string, displayName: string, adapter: string, state: AgentState): AgentView {
    return {
      id,
      displayName,
      adapter,
      state,
      pid: 0,
      restarts: 0,
      lastOutputTs: 0,
      x: 120,
      y: 120,
      homeX: 120,
      homeY: 120,
      targetX: 120,
      targetY: 120,
      idleUntil: 0,
      idleKind: "",
      whipUntil: 0,
      facing: 1,
      bob: Math.random() * Math.PI * 2,
    };
  }

  // anchorHomes spreads each agent's desk "home" position across the first room
  // so multiple avatars do not overlap. Cosmetic only.
  private anchorHomes(): void {
    const room = this.state.office?.rooms?.[0];
    const ids = this.state.order.length ? this.state.order : Object.keys(this.state.agents);
    ids.forEach((id, i) => {
      const a = this.state.agents[id];
      if (!a) return;
      const baseX = room ? room.x + 90 : 90;
      const baseY = room ? room.y + 110 : 110;
      const hx = baseX + (i % 3) * 120;
      const hy = baseY + Math.floor(i / 3) * 90;
      a.homeX = hx;
      a.homeY = hy;
      // If the avatar has never moved, place it at its home.
      if (a.x === 120 && a.y === 120 && a.targetX === 120 && a.targetY === 120) {
        a.x = hx;
        a.y = hy;
        a.targetX = hx;
        a.targetY = hy;
      }
    });
  }
}
