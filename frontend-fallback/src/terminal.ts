// A minimal terminal panel: an auto-scrolling text area that appends agent
// output lines streamed over the WebSocket, capped to a maximum line buffer so
// memory stays bounded during long sessions.

const MAX_LINES = 500;

export class Terminal {
  private lines: string[] = [];
  private pending = "";

  constructor(private el: HTMLElement) {}

  // append adds a chunk of agent output. Chunks may or may not end on a line
  // boundary, so we buffer partial lines and split on newlines.
  append(agentId: string, data: string): void {
    this.pending += data;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(`${agentId}  ${line}`);
    }
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }
    this.render();
  }

  clear(): void {
    this.lines = [];
    this.pending = "";
    this.render();
  }

  private render(): void {
    // Keep it simple and safe: textContent avoids any HTML injection from
    // agent output (which may contain arbitrary characters).
    this.el.textContent = this.lines.join("\n");
    // Auto-scroll to the bottom.
    this.el.scrollTop = this.el.scrollHeight;
  }
}
