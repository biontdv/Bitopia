// Protocol types, parser, and command serializers for the WebSocket contract
// defined in DESIGN.md section 2. This module is framework-agnostic (no React,
// no Pixi, no DOM beyond standard JS) so it can be unit tested under vitest in a
// plain Node environment. Both the production and fallback frontends speak this
// exact envelope shape.

// The single uniform envelope exchanged over the WebSocket.
export interface Envelope<P = unknown> {
  type: string;
  agentId?: string;
  seq: number;
  ts: number;
  payload?: P;
}

// Agent lifecycle states (DESIGN.md section 3.1).
export type AgentState =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "crashed";

// Body of an agent.state envelope.
export interface StatePayload {
  state: AgentState;
  adapter: string;
  displayName: string;
  pid: number;
  restarts: number;
  whipped: boolean;
}

// Body of an agent.output envelope.
export interface OutputPayload {
  stream: "stdout" | "stderr";
  data: string;
}

// One entry in an agent.list roster.
export interface ListEntry {
  id: string;
  displayName: string;
  adapter: string;
  state: AgentState;
}

// Body of an agent.list envelope.
export interface ListPayload {
  agents: ListEntry[];
}

// Office data model (DESIGN.md section 5).
export interface Room {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Furniture {
  id: string;
  type: string;
  roomId: string;
  x: number;
  y: number;
  rotation: number;
}

export interface Office {
  id: string;
  name: string;
  logoRef?: string;
  rooms: Room[];
  furniture: Furniture[];
}

// Body of an error envelope.
export interface ErrorPayload {
  code: string;
  message: string;
}

// Known client-to-server command types.
export const CommandType = {
  Start: "agent.start",
  Pause: "agent.pause",
  Resume: "agent.resume",
  Stop: "agent.stop",
  StopAll: "agent.stopAll",
  Whip: "agent.whip",
  OfficeGet: "office.get",
  OfficeUpdate: "office.update",
} as const;

// parseEnvelope decodes a raw WebSocket text frame into an Envelope. It returns
// null for non-string input or invalid JSON or a payload that is not a
// protocol-shaped object (missing the required string `type`), so callers can
// ignore malformed frames without throwing.
export function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== "string") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const e = obj as Record<string, unknown>;
  if (typeof e.type !== "string" || e.type.length === 0) return null;
  return {
    type: e.type,
    agentId: typeof e.agentId === "string" ? e.agentId : undefined,
    seq: typeof e.seq === "number" ? e.seq : 0,
    ts: typeof e.ts === "number" ? e.ts : 0,
    payload: e.payload,
  };
}

// command builds an outgoing client-to-server envelope. Client messages send
// seq 0 (the server owns the authoritative sequence counter) and a current
// timestamp. The returned object is plain JSON-serializable.
export function command<P>(type: string, agentId: string, payload: P): Envelope<P> {
  return {
    type,
    agentId,
    seq: 0,
    ts: Date.now(),
    payload,
  };
}

// serialize turns a command into the exact JSON string sent over the socket.
export function serialize<P>(type: string, agentId: string, payload: P): string {
  return JSON.stringify(command(type, agentId, payload));
}

// --- typed command serializers -----------------------------------------
//
// Each helper returns the JSON string to send over the WebSocket for a given
// control command. Keeping these pure makes them trivially testable.

export function startAgent(agentId: string, adapter?: string): string {
  return serialize(CommandType.Start, agentId, adapter ? { adapter } : {});
}

export function pauseAgent(agentId: string): string {
  return serialize(CommandType.Pause, agentId, {});
}

export function resumeAgent(agentId: string): string {
  return serialize(CommandType.Resume, agentId, {});
}

export function stopAgent(agentId: string, graceMs?: number): string {
  return serialize(CommandType.Stop, agentId, graceMs ? { graceMs } : {});
}

export function stopAll(): string {
  return serialize(CommandType.StopAll, "", {});
}

export function whipAgent(agentId: string): string {
  return serialize(CommandType.Whip, agentId, {});
}

export function getOffice(): string {
  return serialize(CommandType.OfficeGet, "", {});
}

export function updateOffice(office: Partial<Office>): string {
  return serialize(CommandType.OfficeUpdate, "", office);
}
