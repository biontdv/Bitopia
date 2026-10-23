// Unit tests for the framework-agnostic WebSocket protocol parser and command
// serializers. These run under vitest in a plain Node environment (no browser),
// so `npm test` is meaningful on the networked build machine.

import { describe, it, expect } from "vitest";
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
  type Envelope,
} from "./protocol";

describe("parseEnvelope", () => {
  it("parses a well-formed server envelope", () => {
    const raw = JSON.stringify({
      type: "agent.state",
      agentId: "agent-1",
      seq: 7,
      ts: 1736500000050,
      payload: { state: "running", whipped: false },
    });
    const env = parseEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env?.type).toBe("agent.state");
    expect(env?.agentId).toBe("agent-1");
    expect(env?.seq).toBe(7);
    expect(env?.ts).toBe(1736500000050);
    expect((env?.payload as { state: string }).state).toBe("running");
  });

  it("returns null for non-string input", () => {
    expect(parseEnvelope(42)).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ type: "agent.state" })).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseEnvelope("{not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("returns null when the required type field is missing or empty", () => {
    expect(parseEnvelope(JSON.stringify({ seq: 1, ts: 2 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ type: "", seq: 1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ type: 123 }))).toBeNull();
  });

  it("defaults missing optional numeric fields to zero", () => {
    const env = parseEnvelope(JSON.stringify({ type: "office.get" }));
    expect(env).not.toBeNull();
    expect(env?.seq).toBe(0);
    expect(env?.ts).toBe(0);
    expect(env?.agentId).toBeUndefined();
  });

  it("ignores a non-string agentId rather than failing", () => {
    const env = parseEnvelope(JSON.stringify({ type: "x", agentId: 5 }));
    expect(env?.agentId).toBeUndefined();
  });
});

// Helper: parse a serialized command string back into an envelope so we can
// assert on the shape without comparing brittle JSON text.
function decode(s: string): Envelope {
  return JSON.parse(s) as Envelope;
}

describe("command serializers", () => {
  it("startAgent includes the adapter only when provided", () => {
    const withAdapter = decode(startAgent("agent-1", "mock"));
    expect(withAdapter.type).toBe("agent.start");
    expect(withAdapter.agentId).toBe("agent-1");
    expect(withAdapter.seq).toBe(0);
    expect(withAdapter.payload).toEqual({ adapter: "mock" });

    const noAdapter = decode(startAgent("agent-1"));
    expect(noAdapter.payload).toEqual({});
  });

  it("pause, resume, whip carry an empty payload and the agent id", () => {
    for (const [fn, type] of [
      [pauseAgent, "agent.pause"],
      [resumeAgent, "agent.resume"],
      [whipAgent, "agent.whip"],
    ] as const) {
      const env = decode(fn("agent-2"));
      expect(env.type).toBe(type);
      expect(env.agentId).toBe("agent-2");
      expect(env.payload).toEqual({});
      expect(env.seq).toBe(0);
    }
  });

  it("stopAgent includes graceMs only when provided", () => {
    expect(decode(stopAgent("agent-1")).payload).toEqual({});
    expect(decode(stopAgent("agent-1", 3000)).payload).toEqual({ graceMs: 3000 });
  });

  it("stopAll and getOffice have no agent scope", () => {
    const sa = decode(stopAll());
    expect(sa.type).toBe("agent.stopAll");
    expect(sa.agentId).toBe("");

    const go = decode(getOffice());
    expect(go.type).toBe("office.get");
    expect(go.agentId).toBe("");
  });

  it("updateOffice sends the office object as the payload", () => {
    const office = {
      id: "office-1",
      name: "HQ",
      rooms: [{ id: "room-1", name: "Eng", x: 0, y: 0, w: 800, h: 480 }],
      furniture: [],
    };
    const env = decode(updateOffice(office));
    expect(env.type).toBe("office.update");
    expect(env.payload).toEqual(office);
  });

  it("every serialized command carries a numeric timestamp", () => {
    const env = decode(pauseAgent("a"));
    expect(typeof env.ts).toBe("number");
    expect(env.ts).toBeGreaterThan(0);
  });
});
