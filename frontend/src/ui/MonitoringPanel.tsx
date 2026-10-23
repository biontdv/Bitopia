// Friendly monitoring panel. Lists agents as cards with per-agent Start / Pause
// / Resume / Stop and a playful "Cambuk" (whip) button, plus an orchestrator /
// main-agent row with a "Stop all work" control. Selecting a card routes its
// output to the terminal and diff panels.
//
// Buttons are enabled/disabled by lifecycle state so the UI reads clearly and
// stays approachable (the user explicitly asked for a friendlier UI than the
// reference). All commands flow through the WsClient; all state comes from the
// vanilla Zustand store via slice hooks.

import { useWs } from "../ws/WsContext";
import { officeStore } from "../store/store";
import type { AgentView } from "../store/store";
import type { AgentState } from "../ws/protocol";
import {
  useOffice,
  selectConnected,
  selectOrder,
  selectError,
  selectSelectedAgentId,
} from "../store/hooks";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "chilling",
  starting: "booting up",
  running: "on it!",
  paused: "paused",
  stopping: "wrapping up",
  stopped: "off the clock",
  crashed: "crashed",
};

export function MonitoringPanel() {
  const ws = useWs();
  const connected = useOffice(selectConnected);
  const order = useOffice(selectOrder);
  const error = useOffice(selectError);

  return (
    <section className="panel">
      <div className="orchestrator">
        <div className="orch-label">
          <span className="orch-title">Orchestrator</span>
          <span className={`conn-dot ${connected ? "on" : "off"}`} />
          <span className="conn-text">{connected ? "connected" : "offline"}</span>
        </div>
        <button className="btn btn-stop-all" onClick={() => ws.stopAll()}>
          Stop all work
        </button>
      </div>

      {error ? <div className="error-line">{error}</div> : null}

      {order.length === 0 ? (
        <p className="muted">No agents configured yet.</p>
      ) : (
        <div className="agent-list">
          {order.map((id) => (
            <AgentCard key={id} id={id} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentCard({ id }: { id: string }) {
  const ws = useWs();
  // Select just this agent's view so the card re-renders only when it changes.
  const a = useOffice((s) => s.agents[id] as AgentView | undefined);
  const selectedId = useOffice(selectSelectedAgentId);
  if (!a) return null;

  const state = a.state;
  const canStart = ["idle", "stopped", "crashed"].includes(state);
  const canPause = state === "running";
  const canResume = state === "paused";
  const canStop = ["running", "paused", "starting"].includes(state);
  const selected = selectedId === id;

  return (
    <div
      className={`agent-card ${selected ? "selected" : ""}`}
      onClick={() => officeStore.getState().selectAgent(id)}
    >
      <div className="agent-head">
        <span className={`state-dot ${state}`} />
        <span className="agent-name">{a.displayName}</span>
        <span className="agent-meta">
          {a.adapter} · {STATE_LABEL[state]}
        </span>
      </div>
      <div className="agent-buttons" onClick={(e) => e.stopPropagation()}>
        <button className="btn" disabled={!canStart} onClick={() => ws.startAgent(id)}>
          Start
        </button>
        <button className="btn" disabled={!canPause} onClick={() => ws.pauseAgent(id)}>
          Pause
        </button>
        <button className="btn" disabled={!canResume} onClick={() => ws.resumeAgent(id)}>
          Resume
        </button>
        <button className="btn" disabled={!canStop} onClick={() => ws.stopAgent(id)}>
          Stop
        </button>
        <button
          className="btn btn-whip"
          title="Cambuk! Just for fun, no effect on the real process."
          onClick={() => ws.whipAgent(id)}
        >
          Cambuk
        </button>
      </div>
    </div>
  );
}
