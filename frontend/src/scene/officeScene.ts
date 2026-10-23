// Pixi.js v8 office scene controller. This class owns a Pixi Application and all
// cosmetic animation state (sprite positions, idle behavior, whip reaction
// timers). It reads the vanilla Zustand store every ticker frame via
// store.getState() and never goes through React, so high-frequency WS updates
// animate smoothly.
//
// Pixi v8 notes:
//  - Application is created empty and initialized with the ASYNC `init()` call
//    (v8 pattern), which sets up the WebGL/WebGPU renderer and the shared ticker.
//  - Graphics uses the v8 chainable API (rect().fill(), roundRect().stroke()).
//  - A Texture is built from the uploaded company logo via Assets.load when the
//    office logoRef changes.
//
// The scene renders: a floor, each room, furniture (desk/sofa/billiard/coffee/
// plant/whiteboard), the company logo, and one friendly agent avatar per agent.
// Avatars walk with an eased lerp, show a status speech bubble bound to
// agent.state, wander to furniture anchors for ambient idle behavior when they
// have no active task (relax on sofa, make coffee, play billiard, light social
// chatter), and play a one-shot whip reaction (shake + surprised expression)
// that never changes run state.

import {
  Application,
  Container,
  Graphics,
  Text,
  Assets,
  Sprite,
  Texture,
} from "pixi.js";
import type { OfficeStore } from "../store/store";
import type { AgentView } from "../store/store";
import type { Furniture, Office } from "../ws/protocol";

const COLORS = {
  floor: 0xfdf6ec,
  floorGrid: 0xf0e6d6,
  roomFill: 0xffffff,
  roomStroke: 0xffcf87,
  roomLabel: 0xb5784a,
  bubbleFill: 0xffffff,
  bubbleStroke: 0xffcf87,
  bubbleText: 0x5a4632,
  shadow: 0x000000,
  head: 0xffe0bd,
  eye: 0x3a2e22,
};

const FURNITURE_COLORS: Record<string, number> = {
  desk: 0xd7a86e,
  sofa: 0xf08a8a,
  couch: 0xf08a8a,
  billiard: 0x5ebf87,
  coffee: 0xc58b5a,
  plant: 0x5ebf87,
  whiteboard: 0xdfe7f5,
  generic: 0xbcd0e8,
};

const STATE_INFO: Record<string, { label: string; color: number }> = {
  idle: { label: "chilling", color: 0x9aa7bd },
  starting: { label: "booting up", color: 0xf0b429 },
  running: { label: "on it!", color: 0x2fb67c },
  paused: { label: "paused", color: 0xf0b429 },
  stopping: { label: "wrapping up", color: 0xe8935a },
  stopped: { label: "off the clock", color: 0x9aa7bd },
  crashed: { label: "oops, crashed", color: 0xe5484d },
};

// How long a running agent may go without output before its avatar wanders to
// an idle spot (ms).
const IDLE_OUTPUT_GAP = 2500;

// Per-agent cosmetic animation bookkeeping, owned entirely by the scene.
interface AgentAnim {
  node: Container;
  body: Graphics;
  face: Graphics;
  bubble: Container;
  bubbleBg: Graphics;
  bubbleText: Text;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  targetX: number;
  targetY: number;
  idleUntil: number;
  idleKind: string;
  whipUntil: number;
  lastWhipSeq: number;
  facing: number;
  bob: number;
}

export class OfficeScene {
  private app: Application;
  private world = new Container();
  private floor = new Graphics();
  private officeLayer = new Container();
  private agentLayer = new Container();
  private logoSprite: Sprite | null = null;
  private logoRef = "";
  private anims = new Map<string, AgentAnim>();
  private lastOfficeRef: Office | null = null;
  private running = false;

  constructor(private store: OfficeStore) {
    this.app = new Application();
  }

  // init follows the Pixi v8 async Application.init pattern. It must be awaited
  // before the scene is used.
  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.app.init({
      canvas,
      antialias: true,
      backgroundColor: COLORS.floor,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: canvas.parentElement ?? canvas,
    });

    this.world.addChild(this.floor);
    this.world.addChild(this.officeLayer);
    this.world.addChild(this.agentLayer);
    this.app.stage.addChild(this.world);

    this.running = true;
    this.app.ticker.add((ticker) => this.update(ticker.deltaMS / 1000));
  }

  // destroy tears down the Pixi Application and its GPU resources. Called from
  // the React component's useEffect cleanup on unmount.
  destroy(): void {
    this.running = false;
    this.app.destroy(true, { children: true, texture: true });
    this.anims.clear();
  }

  private update(dt: number): void {
    if (!this.running) return;
    const s = this.store.getState();
    this.syncOffice(s.office);
    this.syncLogo(s.office);
    this.layout();
    this.syncAgents();

    const now = Date.now();
    const agents = s.agents;
    for (const [id, anim] of this.anims) {
      const a = agents[id];
      if (!a) continue;
      this.updateAgent(a, anim, now, dt);
    }
  }

  // layout fits the office design-space bounds into the current renderer size.
  private layout(): void {
    const s = this.store.getState();
    const bounds = sceneBounds(s.office);
    const sw = this.app.renderer.width / this.app.renderer.resolution;
    const sh = this.app.renderer.height / this.app.renderer.resolution;
    const pad = 24;
    const scale = Math.min((sw - pad * 2) / bounds.w, (sh - pad * 2) / bounds.h);
    this.world.scale.set(scale);
    this.world.x = (sw - bounds.w * scale) / 2 - bounds.x * scale;
    this.world.y = (sh - bounds.h * scale) / 2 - bounds.y * scale;

    // Floor grid spanning the design bounds.
    this.floor.clear();
    this.floor.rect(bounds.x, bounds.y, bounds.w, bounds.h).fill(COLORS.floor);
    const gap = 32;
    for (let x = bounds.x; x <= bounds.x + bounds.w; x += gap) {
      this.floor.moveTo(x, bounds.y).lineTo(x, bounds.y + bounds.h);
    }
    for (let y = bounds.y; y <= bounds.y + bounds.h; y += gap) {
      this.floor.moveTo(bounds.x, y).lineTo(bounds.x + bounds.w, y);
    }
    this.floor.stroke({ width: 1, color: COLORS.floorGrid });
  }

  // syncOffice rebuilds the room + furniture graphics when the office changes.
  private syncOffice(office: Office | null): void {
    if (office === this.lastOfficeRef) return;
    this.lastOfficeRef = office;
    this.officeLayer.removeChildren();
    if (!office) return;

    for (const room of office.rooms) {
      const g = new Graphics();
      g.roundRect(room.x, room.y, room.w, room.h, 18)
        .fill(COLORS.roomFill)
        .stroke({ width: 4, color: COLORS.roomStroke });
      this.officeLayer.addChild(g);

      const label = new Text({
        text: room.name,
        style: { fill: COLORS.roomLabel, fontSize: 20, fontWeight: "600", fontFamily: "system-ui" },
      });
      label.x = room.x + 14;
      label.y = room.y + 12;
      this.officeLayer.addChild(label);
    }

    for (const f of office.furniture) {
      this.officeLayer.addChild(this.buildFurniture(f));
    }

    if (this.logoSprite) this.officeLayer.addChild(this.logoSprite);
  }

  private buildFurniture(f: Furniture): Container {
    const node = new Container();
    const size = furnitureSize(f.type);
    const color = FURNITURE_COLORS[f.type] ?? FURNITURE_COLORS.generic;
    const g = new Graphics();
    g.roundRect(0, 0, size.w, size.h, 10).fill(color);
    node.addChild(g);

    const label = new Text({
      text: furnitureIcon(f.type),
      style: { fill: 0x3a2e22, fontSize: 13, fontWeight: "600", fontFamily: "system-ui" },
    });
    label.anchor.set(0.5);
    label.x = size.w / 2;
    label.y = size.h / 2;
    node.addChild(label);

    node.x = f.x;
    node.y = f.y;
    node.rotation = ((f.rotation || 0) * Math.PI) / 180;
    return node;
  }

  // syncLogo loads the uploaded company logo texture when logoRef changes.
  private syncLogo(office: Office | null): void {
    const ref = office?.logoRef ?? "";
    if (ref === this.logoRef) return;
    this.logoRef = ref;
    if (this.logoSprite) {
      this.logoSprite.destroy();
      this.logoSprite = null;
    }
    if (!ref) return;
    // Pixi v8 asset loading is async; place the sprite once the texture loads.
    void Assets.load<Texture>(ref)
      .then((texture) => {
        if (this.logoRef !== ref) return; // changed again meanwhile
        const sprite = new Sprite(texture);
        const room = office?.rooms?.[0];
        const maxW = 120;
        const ratio = texture.height / texture.width || 1;
        sprite.width = maxW;
        sprite.height = maxW * ratio;
        if (room) {
          sprite.x = room.x + room.w - maxW - 16;
          sprite.y = room.y + 12;
        }
        sprite.alpha = 0.95;
        this.logoSprite = sprite;
        this.officeLayer.addChild(sprite);
      })
      .catch(() => {
        // Ignore load errors; the scene renders fine without a logo.
      });
  }

  // syncAgents creates or removes avatar nodes to match the roster.
  private syncAgents(): void {
    const s = this.store.getState();
    const ids = s.order.length ? s.order : Object.keys(s.agents);

    // Remove avatars for agents that disappeared.
    for (const id of [...this.anims.keys()]) {
      if (!ids.includes(id)) {
        const anim = this.anims.get(id);
        anim?.node.destroy({ children: true });
        this.anims.delete(id);
      }
    }

    const room = s.office?.rooms?.[0];
    ids.forEach((id, i) => {
      const a = s.agents[id];
      if (!a) return;
      const baseX = room ? room.x + 90 : 90;
      const baseY = room ? room.y + 110 : 110;
      const hx = baseX + (i % 3) * 120;
      const hy = baseY + Math.floor(i / 3) * 90;
      let anim = this.anims.get(id);
      if (!anim) {
        anim = this.buildAgent(a, hx, hy);
        this.anims.set(id, anim);
        this.agentLayer.addChild(anim.node);
      }
      anim.homeX = hx;
      anim.homeY = hy;
    });
  }

  private buildAgent(a: AgentView, hx: number, hy: number): AgentAnim {
    const node = new Container();

    const shadow = new Graphics();
    shadow.ellipse(0, 26, 16, 5).fill({ color: COLORS.shadow, alpha: 0.12 });
    node.addChild(shadow);

    const body = new Graphics();
    node.addChild(body);

    const head = new Graphics();
    head.circle(0, -16, 12).fill(COLORS.head);
    node.addChild(head);

    const face = new Graphics();
    node.addChild(face);

    // Speech bubble as a child container drawn above the avatar.
    const bubble = new Container();
    const bubbleBg = new Graphics();
    const bubbleText = new Text({
      text: "",
      style: { fill: COLORS.bubbleText, fontSize: 13, fontWeight: "600", fontFamily: "system-ui" },
    });
    bubbleText.x = 10;
    bubbleText.y = 5;
    bubble.addChild(bubbleBg);
    bubble.addChild(bubbleText);
    bubble.y = -58;
    node.addChild(bubble);

    node.x = hx;
    node.y = hy;

    return {
      node,
      body,
      face,
      bubble,
      bubbleBg,
      bubbleText,
      x: hx,
      y: hy,
      homeX: hx,
      homeY: hy,
      targetX: hx,
      targetY: hy,
      idleUntil: 0,
      idleKind: "",
      whipUntil: 0,
      lastWhipSeq: a.whipSeq,
      facing: 1,
      bob: Math.random() * Math.PI * 2,
    };
  }

  private updateAgent(a: AgentView, anim: AgentAnim, now: number, dt: number): void {
    // Detect a new whip event: the store bumps whipSeq, the scene fires a
    // one-shot reaction here. No lifecycle state is touched.
    if (a.whipSeq !== anim.lastWhipSeq) {
      anim.lastWhipSeq = a.whipSeq;
      anim.whipUntil = now + 900;
      anim.idleUntil = 0;
      anim.idleKind = "";
    }
    const whipping = now < anim.whipUntil;

    const activelyWorking = a.state === "running" && now - a.lastOutputTs < IDLE_OUTPUT_GAP;
    const canWander =
      !whipping &&
      (a.state === "idle" ||
        a.state === "stopped" ||
        a.state === "paused" ||
        (a.state === "running" && !activelyWorking));

    if (activelyWorking || a.state === "starting" || a.state === "stopping") {
      // Working: return to the home desk and stay there.
      anim.idleKind = "";
      anim.idleUntil = 0;
      anim.targetX = anim.homeX;
      anim.targetY = anim.homeY;
    } else if (canWander && now >= anim.idleUntil) {
      this.pickIdleSpot(anim, now);
    }

    // Eased lerp toward the target (friendly, not twitchy).
    const dx = anim.targetX - anim.x;
    const dy = anim.targetY - anim.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const speed = 90;
      const step = Math.min(speed * dt, dist);
      anim.x += (dx / dist) * step;
      anim.y += (dy / dist) * step;
      anim.facing = dx >= 0 ? 1 : -1;
    }
    anim.bob += dt * (anim.idleKind ? 3 : 1.5);
    const bobY = Math.sin(anim.bob) * 2;

    // Position the node, with a quick horizontal shake during a whip reaction.
    let shake = 0;
    if (whipping) shake = Math.sin(now / 25) * 4;
    anim.node.x = anim.x + shake;
    anim.node.y = anim.y + bobY;

    this.drawBody(anim, a.adapter);
    this.drawFace(anim, whipping);
    this.drawBubble(anim, a, now);
  }

  private pickIdleSpot(anim: AgentAnim, now: number): void {
    const s = this.store.getState();
    const anchors = idleAnchors(s.office);
    if (anchors.length === 0) {
      anim.targetX = anim.homeX + (Math.random() * 80 - 40);
      anim.targetY = anim.homeY + (Math.random() * 60 - 30);
      anim.idleKind = "stretch";
      anim.idleUntil = now + 2500 + Math.random() * 2000;
      return;
    }
    // Weighted selection so the office looks lively but coffee/billiard do not
    // dominate. Light "social" chatter happens near a sofa/coffee cluster.
    const pick = anchors[Math.floor(Math.random() * anchors.length)];
    const social = Math.random() < 0.25;
    anim.targetX = pick.x + (social ? 18 : 0);
    anim.targetY = pick.y;
    anim.idleKind = social ? "social" : pick.kind;
    anim.idleUntil = now + 3500 + Math.random() * 3500;
  }

  private drawBody(anim: AgentAnim, adapter: string): void {
    anim.body.clear();
    anim.body.roundRect(-14, -6, 28, 30, 10).fill(adapterColor(adapter));
  }

  private drawFace(anim: AgentAnim, whipping: boolean): void {
    const g = anim.face;
    g.clear();
    const eo = anim.facing * 2;
    g.circle(-4 + eo, -17, 1.8).circle(4 + eo, -17, 1.8).fill(COLORS.eye);
    if (whipping) {
      // Sweat drop + surprised expression. Cosmetic only.
      g.circle(9, -20, 2.4).fill(0x6cc3ff);
    } else if (anim.idleKind) {
      // Relaxed smile arc.
      g.arc(0, -13, 4, 0.1 * Math.PI, 0.9 * Math.PI).stroke({ width: 1.4, color: COLORS.eye });
    }
  }

  private drawBubble(anim: AgentAnim, a: AgentView, now: number): void {
    const info = STATE_INFO[a.state] ?? { label: a.state, color: 0x9aa7bd };
    const whipping = now < anim.whipUntil;
    let text = `${a.displayName}: ${info.label}`;
    if (whipping) text = `${a.displayName}: yikes!`;
    else if (anim.idleKind && anim.idleKind !== "stretch") {
      text = `${a.displayName}: ${idleCaption(anim.idleKind)}`;
    }

    anim.bubbleText.text = text;
    const tw = anim.bubbleText.width;
    const bw = tw + 20;
    const bh = 24;
    anim.bubbleBg.clear();
    anim.bubbleBg
      .roundRect(0, 0, bw, bh, 10)
      .fill(COLORS.bubbleFill)
      .stroke({ width: 2, color: whipping ? 0xe5484d : COLORS.bubbleStroke });
    // Tail.
    anim.bubbleBg
      .moveTo(bw / 2 - 5, bh)
      .lineTo(bw / 2 + 5, bh)
      .lineTo(bw / 2, bh + 7)
      .fill(COLORS.bubbleFill);
    anim.bubble.x = -bw / 2;
  }
}

// --- helpers -------------------------------------------------------------

interface Anchor {
  x: number;
  y: number;
  kind: string;
}

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
    case "social":
      return "chatting with the team";
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

function adapterColor(adapter: string): number {
  switch (adapter) {
    case "claude":
      return 0xd79a6a;
    case "codex":
      return 0x6aa9d7;
    case "antigravity":
      return 0xa98ad8;
    default:
      return 0x7fc6a3; // mock
  }
}

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
  return { x: minX - margin, y: minY - margin, w: maxX - minX + margin * 2, h: maxY - minY + margin * 2 };
}
