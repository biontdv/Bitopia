// Protocol types and helpers for the WebSocket contract defined in DESIGN.md
// section 2. Both frontends speak this exact shape; this fallback UI uses only
// the DOM lib and no external packages.

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

// Build an outgoing client->server envelope. Client messages may send seq 0.
export function command(type: string, agentId: string, payload: unknown): Envelope {
  return {
    type,
    agentId,
    seq: 0,
    ts: Date.now(),
    payload,
  };
}
