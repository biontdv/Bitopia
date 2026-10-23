// xterm.js terminal panel with the WebGL addon. It streams the selected agent's
// PTY/MOCK output from the vanilla Zustand store. The WebGL addon offloads text
// rendering to the GPU, which is the user's stated rationale: it keeps many
// concurrent high-frequency output streams smooth where the DOM renderer would
// stutter.
//
// The terminal subscribes to the store OUTSIDE React render for the hot path:
// it watches the per-agent outputSeq bump and writes only the newly appended
// slice, so a burst of agent.output does not trigger React renders. React is
// used only to (re)create the terminal when the selected agent changes.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { officeStore } from "../store/store";
import { useOffice, selectSelectedAgentId } from "../store/hooks";

export function TerminalView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedId = useOffice(selectSelectedAgentId);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#1e1b16",
        foreground: "#f3ead9",
        cursor: "#ffcf87",
      },
    });

    // The WebGL addon offloads glyph rendering to the GPU for throughput.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      // If WebGL is unavailable the terminal falls back to the DOM renderer.
      webgl = null;
    }

    term.open(container);

    // Seed with whatever is already buffered for this agent, then follow the
    // outputSeq counter to append only the new tail on each change.
    let lastLen = 0;
    const id = selectedId;

    const writeFrom = () => {
      if (!id) return;
      const buf = officeStore.getState().output[id] ?? "";
      if (buf.length < lastLen) {
        // Buffer was trimmed (ring overflow); reset the view.
        term.clear();
        term.write(buf);
      } else if (buf.length > lastLen) {
        term.write(buf.slice(lastLen));
      }
      lastLen = buf.length;
    };

    // Initial paint.
    if (id) {
      term.writeln(`\x1b[2m-- streaming ${id} --\x1b[0m`);
      writeFrom();
    } else {
      term.writeln("\x1b[2m-- select an agent to stream its output --\x1b[0m");
    }

    // Subscribe outside React render: fires on every store setState but we only
    // touch the terminal when this agent's outputSeq actually advanced.
    let lastSeq = id ? officeStore.getState().outputSeq[id] ?? 0 : 0;
    const unsub = officeStore.subscribe((state) => {
      if (!id) return;
      const seq = state.outputSeq[id] ?? 0;
      if (seq !== lastSeq) {
        lastSeq = seq;
        writeFrom();
      }
    });

    return () => {
      unsub();
      webgl?.dispose();
      term.dispose();
    };
  }, [selectedId]);

  return <div ref={containerRef} className="terminal-host" />;
}
