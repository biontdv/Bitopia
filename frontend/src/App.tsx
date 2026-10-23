// Application shell. It composes the office scene, the monitoring controls, the
// office setup view, the terminal, and the Monaco diff into a friendly layout
// with a tabbed side rail (Monitoring / Office setup). The WebSocket connection
// is initialized once on mount and provided to the UI via WsContext; the client
// feeds the vanilla Zustand store outside React render.

import { useEffect, useRef, useState } from "react";
import { WsClient } from "./ws/client";
import { WsProvider } from "./ws/WsContext";
import { officeStore } from "./store/store";
import { OfficeSceneView } from "./scene/OfficeSceneView";
import { TerminalView } from "./terminal/TerminalView";
import { DiffView } from "./diff/DiffView";
import { MonitoringPanel } from "./ui/MonitoringPanel";
import { OfficeSetup } from "./ui/OfficeSetup";

type Tab = "monitoring" | "setup";
type BottomTab = "terminal" | "diff";

export default function App() {
  const wsRef = useRef<WsClient | null>(null);
  if (!wsRef.current) wsRef.current = new WsClient(officeStore);
  const [tab, setTab] = useState<Tab>("monitoring");
  const [bottom, setBottom] = useState<BottomTab>("terminal");

  useEffect(() => {
    const ws = wsRef.current;
    ws?.connect();
    return () => ws?.close();
  }, []);

  return (
    <WsProvider value={wsRef.current}>
      <div className="app">
        <header className="topbar">
          <span className="brand">Agentic Virtual Office</span>
          <span className="brand-sub">your friendly AI team at work</span>
        </header>

        <div className="main">
          <div className="stage">
            <OfficeSceneView />
            <div className="bottom-dock">
              <div className="tabs">
                <button
                  className={`tab ${bottom === "terminal" ? "active" : ""}`}
                  onClick={() => setBottom("terminal")}
                >
                  Terminal
                </button>
                <button
                  className={`tab ${bottom === "diff" ? "active" : ""}`}
                  onClick={() => setBottom("diff")}
                >
                  Code diff
                </button>
              </div>
              <div className="dock-body">
                <div style={{ display: bottom === "terminal" ? "block" : "none", height: "100%" }}>
                  <TerminalView />
                </div>
                <div style={{ display: bottom === "diff" ? "block" : "none", height: "100%" }}>
                  <DiffView />
                </div>
              </div>
            </div>
          </div>

          <aside className="rail">
            <div className="tabs">
              <button
                className={`tab ${tab === "monitoring" ? "active" : ""}`}
                onClick={() => setTab("monitoring")}
              >
                Monitoring
              </button>
              <button
                className={`tab ${tab === "setup" ? "active" : ""}`}
                onClick={() => setTab("setup")}
              >
                Office setup
              </button>
            </div>
            {tab === "monitoring" ? <MonitoringPanel /> : <OfficeSetup />}
          </aside>
        </div>
      </div>
    </WsProvider>
  );
}
