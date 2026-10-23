// WebSocket client: opens /ws, decodes envelopes, and feeds the store. It
// reconnects with a simple backoff and exposes a send() that dispatches
// client->server commands. All updates happen OUTSIDE any framework render
// loop; the store notifies subscribers which re-render on their own schedule.
import { command } from "./protocol.js";
export class Socket {
    constructor(store, onOutput) {
        this.store = store;
        this.onOutput = onOutput;
        this.ws = null;
        this.backoff = 500;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        this.url = `${proto}://${location.host}/ws`;
    }
    connect() {
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
    scheduleReconnect() {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 8000);
        window.setTimeout(() => this.connect(), delay);
    }
    handleMessage(raw) {
        if (typeof raw !== "string")
            return;
        let env;
        try {
            env = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (env.type) {
            case "agent.list": {
                const p = env.payload;
                if (p && Array.isArray(p.agents)) {
                    this.store.upsertFromList(p.agents);
                }
                break;
            }
            case "agent.state": {
                const p = env.payload;
                if (p && env.agentId) {
                    this.store.applyState(env.agentId, p);
                }
                break;
            }
            case "agent.output": {
                const p = env.payload;
                if (p && env.agentId) {
                    this.store.noteOutput(env.agentId);
                    this.onOutput(env.agentId, p.data);
                }
                break;
            }
            case "office.state": {
                const p = env.payload;
                if (p) {
                    this.store.setOffice(p);
                }
                break;
            }
            case "error": {
                const p = env.payload;
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
    send(type, agentId, payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify(command(type, agentId, payload)));
    }
}
