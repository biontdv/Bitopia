// Entry point for the dependency-free fallback UI. It wires the store, the
// WebSocket client, the Canvas office scene, the terminal panel, the monitoring
// controls, and the office setup panel together. No framework, no bundler, DOM
// lib only; compiled by the global tsc and embedded by the daemon so the whole
// vertical slice runs offline.

import { Store } from "./store.js";
import { Socket } from "./socket.js";
import { Scene } from "./scene.js";
import { Terminal } from "./terminal.js";
import { MonitoringPanel, OfficePanel } from "./panels.js";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function main(): void {
  const store = new Store();

  const terminal = new Terminal(byId("terminal"));
  const socket = new Socket(store, (agentId, text) => terminal.append(agentId, text));

  const scene = new Scene(byId<HTMLCanvasElement>("scene"), store);
  scene.start();

  new MonitoringPanel(byId("monitoring"), store, socket);
  new OfficePanel(byId("office-setup"), store, socket);

  // Terminal clear button.
  byId("terminal-clear").addEventListener("click", () => terminal.clear());

  // Tab switching between the monitoring and setup panels keeps the UI tidy.
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.getAttribute("data-tab");
      document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-panel") === target);
      });
    });
  });

  socket.connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
