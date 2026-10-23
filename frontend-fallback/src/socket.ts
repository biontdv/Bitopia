// WebSocket client: opens /ws, decodes envelopes, and feeds the store. It
// reconnects with a simple backoff and exposes a send() that dispatches
// client->server commands. All updates happen OUTSIDE any framework render
// loop; the store notifies subscribers which re-render on their own schedule.

import { command } from "./protocol.js";
import type {
  Envelope,
  ListPayload,
  Office,
  OutputPayload,
  StatePayload,
  ErrorPayload,
} from "./protocol.js";
import type { Store } from "./store.js";

// OutputSink receives raw agent output lines for the terminal panel.
export type OutputSink = (agentId: string, text: string) => void;

export class Socket {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private readonly url: string;

  constructor(private store: Store, private onOutput: OutputSink) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = `${proto}://${location.host}/ws`;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.store.setConnected(true);
      // Ask for current office state; the daemon also seeds roster + office on
      // connect, so this is belt-and-suspenders.
      this.send("office.get", "", {});
    };

    ws.onclose = () => {
      this.store.setConnected(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow and trigger the reconnect.
    };

    ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 8000);
    window.setTimeout(() => this.connect(), delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    switch (env.type) {
      case "agent.list": {
        const p = env.payload as ListPayload | undefined;
        if (p && Array.isArray(p.agents)) {
          this.store.upsertFromList(p.agents);
        }
        break;
      }
      case "agent.state": {
        const p = env.payload as StatePayload | undefined;
        if (p && env.agentId) {
          this.store.applyState(env.agentId, p);
        }
        break;
      }
      case "agent.output": {
        const p = env.payload as OutputPayload | undefined;
        if (p && env.agentId) {
          this.store.noteOutput(env.agentId);
          this.onOutput(env.agentId, p.data);
        }
        break;
      }
      case "office.state": {
        const p = env.payload as Office | undefined;
        if (p) {
          this.store.setOffice(p);
        }
        break;
      }
      case "error": {
        const p = env.payload as ErrorPayload | undefined;
        if (p) {
          this.store.setError(`${p.code}: ${p.message}`);
        }
        break;
      }
      default:
        // Unknown types are ignored so the UI stays forward-compatible.
        break;
    }
  }

  // send dispatches a client->server command envelope.
  send(type: string, agentId: string, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(command(type, agentId, payload)));
  }
}
