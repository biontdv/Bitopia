// Canvas 2D office scene. It draws the rooms, furniture rectangles, the company
// logo (if set), and one friendly agent sprite per agent. Sprites move with a
// simple lerp/walk, show a status speech bubble reflecting agent.state, play a
// cosmetic idle behavior (wander to sofa/coffee/billiard) when they have no
// active task, and play a brief whip reaction on an agent.whip gag.
//
// The scene reads the store every frame and owns only cosmetic animation state;
// it never changes lifecycle state or sends commands.

import type { Store, AgentView, StoreState } from "./store.js";
import type { Furniture, Office } from "./protocol.js";
import { drawPixelArt, hasPixelArt } from "./pixelArt.js";

// A friendly, approachable palette (the user asked for a friendly look).
const COLORS = {
  floor: "#fdf6ec",
  floorGrid: "#f0e6d6",
  roomFill: "#ffffff",
  roomStroke: "#ffcf87",
  roomLabel: "#b5784a",
  desk: "#d7a86e",
  sofa: "#f08a8a",
  couch: "#f08a8a",
  billiard: "#5ebf87",
  coffee: "#c58b5a",
  plant: "#5ebf87",
  whiteboard: "#dfe7f5",
  generic: "#bcd0e8",
  bubbleFill: "#ffffff",
  bubbleStroke: "#ffcf87",
  bubbleText: "#5a4632",
};

// Status label and dot color per lifecycle state.
const STATE_INFO: Record<string, { label: string; color: string }> = {
  idle: { label: "chilling", color: "#9aa7bd" },
  starting: { label: "booting up", color: "#f0b429" },
  running: { label: "on it!", color: "#2fb67c" },
  paused: { label: "paused", color: "#f0b429" },
  stopping: { label: "wrapping up", color: "#e8935a" },
  stopped: { label: "off the clock", color: "#9aa7bd" },
  crashed: { label: "oops, crashed", color: "#e5484d" },
};

// How long a running agent may go without output before its avatar wanders off
// to an idle spot (ms).
const IDLE_OUTPUT_GAP = 2500;

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private logo: HTMLImageElement | null = null;
  private logoRef = "";
  private raf = 0;
  private lastTs = 0;
  // Devic pixel ratio aware sizing.
  private cssW = 0;
  private cssH = 0;

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("scene: 2d canvas context unavailable");
    }
    this.ctx = ctx;
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  // start kicks off the animation loop.
  start(): void {
    const loop = (ts: number) => {
      const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.05) : 0.016;
      this.lastTs = ts;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // loadLogo swaps in the company logo image when the office logoRef changes.
  private loadLogo(office: Office | null): void {
    const ref = office?.logoRef || "";
    if (ref === this.logoRef) return;
    this.logoRef = ref;
    if (!ref) {
      this.logo = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.logo = img;
    };
    img.onerror = () => {
      this.logo = null;
    };
    img.src = ref;
  }

  // update advances cosmetic animation: movement, idle wandering, whip timers.
  private update(dt: number): void {
    const s = this.store.get();
    this.loadLogo(s.office);
    const now = Date.now();
    for (const id of agentIds(s)) {
      const a = s.agents[id];
      if (!a) continue;
      this.updateAgent(a, s, now, dt);
    }
  }

  private updateAgent(a: AgentView, s: StoreState, now: number, dt: number): void {
    // Whip reaction interrupts idle wandering but never changes run state.
    const whipping = now < a.whipUntil;

    // Decide where this avatar wants to be.
    const activelyWorking =
      a.state === "running" && now - a.lastOutputTs < IDLE_OUTPUT_GAP;
    const canWander =
      !whipping &&
      (a.state === "idle" ||
        a.state === "stopped" ||
        a.state === "paused" ||
        (a.state === "running" && !activelyWorking));

    if (activelyWorking || a.state === "starting" || a.state === "stopping") {
      // Working: head back to the home desk and stay there.
      a.idleKind = "";
      a.idleUntil = 0;
      a.targetX = a.homeX;
      a.targetY = a.homeY;
    } else if (canWander) {
      // Idle: if not already lingering, pick an ambient behavior spot.
      if (now >= a.idleUntil) {
        this.pickIdleSpot(a, s, now);
      }
    }

    // Move toward the target with a simple eased lerp (friendly, not twitchy).
    const dx = a.targetX - a.x;
    const dy = a.targetY - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const speed = 90; // px/sec
      const step = Math.min(speed * dt, dist);
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;
      a.facing = dx >= 0 ? 1 : -1;
    }
    // Gentle bob while idling at a spot or relaxing.
    a.bob += dt * (a.idleKind ? 3 : 1.5);
  }

  // pickIdleSpot routes an idle avatar to a nearby furniture anchor and sets a
  // linger timer. Cosmetic only.
  private pickIdleSpot(a: AgentView, s: StoreState, now: number): void {
    const anchors = idleAnchors(s.office);
    if (anchors.length === 0) {
      // No furniture: just wander a little around the home desk.
      a.targetX = a.homeX + (Math.random() * 80 - 40);
      a.targetY = a.homeY + (Math.random() * 60 - 30);
      a.idleKind = "stretch";
      a.idleUntil = now + 2500 + Math.random() * 2000;
      return;
    }
    const pick = anchors[Math.floor(Math.random() * anchors.length)];
    a.targetX = pick.x;
    a.targetY = pick.y;
    a.idleKind = pick.kind;
    a.idleUntil = now + 3500 + Math.random() * 3500;
  }

  private draw(): void {
    const s = this.store.get();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // Floor backdrop.
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    this.drawFloorGrid();

    // Fit the office scene (design coordinates) into the canvas.
    const office = s.office;
    const bounds = sceneBounds(office);
    const pad = 24;
    const scale = Math.min(
      (this.cssW - pad * 2) / bounds.w,
      (this.cssH - pad * 2) / bounds.h
    );
    const offX = (this.cssW - bounds.w * scale) / 2 - bounds.x * scale;
    const offY = (this.cssH - bounds.h * scale) / 2 - bounds.y * scale;

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    if (office) {
      for (const room of office.rooms) {
        this.drawRoom(room);
      }
      for (const f of office.furniture) {
        this.drawFurniture(f);
      }
      this.drawLogo(office);
    }

    const now = Date.now();
    for (const id of agentIds(s)) {
      const a = s.agents[id];
      if (a) this.drawAgent(a, now);
    }

    ctx.restore();

    if (!office) {
      this.drawCenterHint("Loading your office...");
    } else if (agentIds(s).length === 0) {
      this.drawCenterHint("No agents yet. Start one from the monitoring panel.");
    }
  }

  private drawFloorGrid(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.floorGrid;
    ctx.lineWidth = 1;
    const gap = 32;
    for (let x = 0; x < this.cssW; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.cssH);
      ctx.stroke();
    }
    for (let y = 0; y < this.cssH; y += gap) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.cssW, y);
      ctx.stroke();
    }
  }

  private drawRoom(room: { x: number; y: number; w: number; h: number; name: string }): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.roomFill;
    ctx.strokeStyle = COLORS.roomStroke;
    ctx.lineWidth = 4;
    roundRect(ctx, room.x, room.y, room.w, room.h, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.roomLabel;
    ctx.font = "600 20px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(room.name, room.x + 14, room.y + 12);
  }

  private drawFurniture(f: Furniture): void {
    const ctx = this.ctx;
    const size = furnitureSize(f.type);
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(((f.rotation || 0) * Math.PI) / 180);
    // `sofa` and `desk` use programmatic pixel-art sprites (Opsi A); every
    // other furniture type keeps its plain rounded-rect + icon look.
    if (hasPixelArt(f.type) && drawPixelArt(ctx, f.type, size.w, size.h)) {
      ctx.restore();
      return;
    }
    const color = COLORS[f.type as keyof typeof COLORS] || COLORS.generic;
    ctx.fillStyle = color;
    roundRect(ctx, 0, 0, size.w, size.h, 10);
    ctx.fill();
    // A little icon / label so furniture reads clearly and stays friendly.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(furnitureIcon(f.type), size.w / 2, size.h / 2);
    ctx.restore();
  }

  private drawLogo(office: Office): void {
    if (!this.logo || !office.rooms.length) return;
    const room = office.rooms[0];
    const maxW = 120;
    const ratio = this.logo.height / this.logo.width || 1;
    const w = maxW;
    const h = maxW * ratio;
    const x = room.x + room.w - w - 16;
    const y = room.y + 12;
    this.ctx.save();
    this.ctx.globalAlpha = 0.95;
    this.ctx.drawImage(this.logo, x, y, w, h);
    this.ctx.restore();
  }

  private drawAgent(a: AgentView, now: number): void {
    const ctx = this.ctx;
    const whipping = now < a.whipUntil;
    const bobY = Math.sin(a.bob) * 2;

    ctx.save();
    ctx.translate(a.x, a.y + bobY);

    // Whip reaction: a quick horizontal shake. Cosmetic, no state change.
    if (whipping) {
      const shake = Math.sin(now / 25) * 4;
      ctx.translate(shake, 0);
    }

    // Shadow.
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    ctx.ellipse(0, 26, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body (friendly rounded blob) tinted by adapter for easy identification.
    const bodyColor = adapterColor(a.adapter);
    ctx.fillStyle = bodyColor;
    roundRect(ctx, -14, -6, 28, 30, 10);
    ctx.fill();

    // Head.
    ctx.fillStyle = "#ffe0bd";
    ctx.beginPath();
    ctx.arc(0, -16, 12, 0, Math.PI * 2);
    ctx.fill();

    // Eyes (follow facing direction).
    ctx.fillStyle = "#3a2e22";
    const eo = a.facing * 2;
    ctx.beginPath();
    ctx.arc(-4 + eo, -17, 1.8, 0, Math.PI * 2);
    ctx.arc(4 + eo, -17, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Expression: whip = surprised "!" + sweat; idle = happy; else neutral.
    if (whipping) {
      // Sweat drop.
      ctx.fillStyle = "#6cc3ff";
      ctx.beginPath();
      ctx.arc(9, -20, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // Exclamation above the head.
      ctx.fillStyle = "#e5484d";
      ctx.font = "700 20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("!", 0, -34);
    } else if (a.idleKind) {
      // Smiling mouth while relaxing.
      ctx.strokeStyle = "#3a2e22";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, -13, 4, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
    }

    ctx.restore();

    // Speech bubble reflecting the lifecycle state (and a hint of the idle gag).
    this.drawBubble(a, now, bobY);
  }

  private drawBubble(a: AgentView, now: number, bobY: number): void {
    const ctx = this.ctx;
    const info = STATE_INFO[a.state] || { label: a.state, color: "#9aa7bd" };
    let text = `${a.displayName}: ${info.label}`;
    const whipping = now < a.whipUntil;
    if (whipping) {
      text = `${a.displayName}: yikes!`;
    } else if (a.idleKind && a.idleKind !== "stretch") {
      text = `${a.displayName}: ${idleCaption(a.idleKind)}`;
    }

    ctx.font = "600 13px system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    const padX = 10;
    const bw = tw + padX * 2;
    const bh = 24;
    const bx = a.x - bw / 2;
    const by = a.y + bobY - 58;

    ctx.fillStyle = COLORS.bubbleFill;
    ctx.strokeStyle = whipping ? "#e5484d" : COLORS.bubbleStroke;
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, bw, bh, 10);
    ctx.fill();
    ctx.stroke();

    // Bubble tail.
    ctx.beginPath();
    ctx.moveTo(a.x - 5, by + bh);
    ctx.lineTo(a.x + 5, by + bh);
    ctx.lineTo(a.x, by + bh + 7);
    ctx.closePath();
    ctx.fillStyle = COLORS.bubbleFill;
    ctx.fill();

    // Status dot.
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(bx + padX, by + bh / 2, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS.bubbleText;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + padX + 8, by + bh / 2 + 1);
  }

  private drawCenterHint(text: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#b5784a";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.cssW / 2, this.cssH / 2);
  }
}

// --- helpers -------------------------------------------------------------

function agentIds(s: StoreState): string[] {
  return s.order.length ? s.order : Object.keys(s.agents);
}

interface Anchor {
  x: number;
  y: number;
  kind: string;
}

// idleAnchors returns furniture spots agents can wander to when idle.
function idleAnchors(office: Office | null): Anchor[] {
  if (!office) return [];
  const anchors: Anchor[] = [];
  for (const f of office.furniture) {
    const kind = idleKindForType(f.type);
    if (!kind) continue;
    const size = furnitureSize(f.type);
    anchors.push({ x: f.x + size.w / 2, y: f.y + size.h + 18, kind });
  }
  return anchors;
}

function idleKindForType(type: string): string {
  switch (type) {
    case "sofa":
    case "couch":
      return "sofa";
    case "coffee":
      return "coffee";
    case "billiard":
      return "billiard";
    default:
      return "";
  }
}

function idleCaption(kind: string): string {
  switch (kind) {
    case "sofa":
      return "relaxing on the sofa";
    case "coffee":
      return "making coffee";
    case "billiard":
      return "playing billiard";
    default:
      return "taking a break";
  }
}

function furnitureSize(type: string): { w: number; h: number } {
  switch (type) {
    case "billiard":
      return { w: 120, h: 70 };
    case "sofa":
    case "couch":
      return { w: 90, h: 44 };
    case "desk":
      return { w: 70, h: 44 };
    case "coffee":
      return { w: 40, h: 40 };
    case "whiteboard":
      return { w: 80, h: 16 };
    case "plant":
      return { w: 30, h: 30 };
    default:
      return { w: 50, h: 40 };
  }
}

function furnitureIcon(type: string): string {
  switch (type) {
    case "desk":
      return "desk";
    case "sofa":
    case "couch":
      return "sofa";
    case "billiard":
      return "billiard";
    case "coffee":
      return "coffee";
    case "plant":
      return "plant";
    case "whiteboard":
      return "board";
    default:
      return type;
  }
}

function adapterColor(adapter: string): string {
  switch (adapter) {
    case "claude":
      return "#d79a6a";
    case "codex":
      return "#6aa9d7";
    case "antigravity":
      return "#a98ad8";
    default:
      return "#7fc6a3"; // mock
  }
}

// sceneBounds computes the drawing bounds from the office rooms, with a default
// so the scene renders before any office arrives.
function sceneBounds(office: Office | null): { x: number; y: number; w: number; h: number } {
  if (!office || office.rooms.length === 0) {
    return { x: 0, y: 0, w: 800, h: 480 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of office.rooms) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const margin = 40;
  return {
    x: minX - margin,
    y: minY - margin,
    w: maxX - minX + margin * 2,
    h: maxY - minY + margin * 2,
  };
}

// roundRect draws a rounded rectangle path (kept local to avoid relying on the
// newer ctx.roundRect which is not in every lib.dom version).
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
