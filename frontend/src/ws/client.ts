// WebSocket client. It connects to /ws, decodes envelopes with the pure
// protocol parser, and writes updates DIRECTLY into the vanilla Zustand store
// via its action methods (which call setState) OUTSIDE React's render cycle.
// This is the user's stated requirement: high-frequency agent.output and
// agent.state traffic must feed Zustand without triggering a React render per
// message. React components re-render only when a slice they subscribe to
// changes.
//
// The client also exposes typed send helpers that reuse the pure command
// serializers from protocol.ts, and reconnects with a simple capped backoff.

import {
  parseEnvelope,
  startAgent,
  pauseAgent,
  resumeAgent,
  stopAgent,
  stopAll,
  whipAgent,
  getOffice,
  updateOffice,
} from "./protocol";
import type {
  ListPayload,
  StatePayload,
  OutputPayload,
  Office,
  ErrorPayload,
} from "./protocol";
import type { OfficeStore } from "../store/store";

export class WsClient {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private closedByUser = false;
  private readonly url: string;

  constructor(private store: OfficeStore) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.store.getState().setConnected(true);
      // Ask for the current office; the daemon also seeds roster + office on
      // connect, so this is belt and suspenders.
      this.sendRaw(getOffice());
    };

    ws.onclose = () => {
      this.store.getState().setConnected(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and drives the reconnect.
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 8000);
    window.setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    const env = parseEnvelope(raw);
    if (!env) return;
    const s = this.store.getState();
    switch (env.type) {
      case "agent.list": {
        const p = env.payload as ListPayload | undefined;
        if (p && Array.isArray(p.agents)) s.upsertFromList(p.agents);
        break;
      }
      case "agent.state": {
        const p = env.payload as StatePayload | undefined;
        if (p && env.agentId) s.applyState(env.agentId, p);
        break;
      }
      case "agent.output": {
        const p = env.payload as OutputPayload | undefined;
        if (p && env.agentId) s.appendOutput(env.agentId, p.data);
        break;
      }
      case "office.state": {
        const p = env.payload as Office | undefined;
        if (p) s.setOffice(p);
        break;
      }
      case "error": {
        const p = env.payload as ErrorPayload | undefined;
        if (p) s.setError(`${p.code}: ${p.message}`);
        break;
      }
      default:
        // Unknown types are ignored for forward compatibility.
        break;
    }
  }

  private sendRaw(frame: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame);
  }

  // --- typed send helpers (reuse the pure serializers) ------------------

  startAgent(agentId: string, adapter?: string): void {
    this.sendRaw(startAgent(agentId, adapter));
  }
  pauseAgent(agentId: string): void {
    this.sendRaw(pauseAgent(agentId));
  }
  resumeAgent(agentId: string): void {
    this.sendRaw(resumeAgent(agentId));
  }
  stopAgent(agentId: string, graceMs?: number): void {
    this.sendRaw(stopAgent(agentId, graceMs));
  }
  stopAll(): void {
    this.sendRaw(stopAll());
  }
  whipAgent(agentId: string): void {
    this.sendRaw(whipAgent(agentId));
  }
  getOffice(): void {
    this.sendRaw(getOffice());
  }
  updateOffice(office: Partial<Office>): void {
    this.sendRaw(updateOffice(office));
  }
}
