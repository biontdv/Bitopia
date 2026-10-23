// Programmatic pixel-art sprites for office furniture ("Opsi A": art generated
// in code, no external image files). Each sprite is a small string matrix ("art
// map") where every character maps to a palette color; the matrix is scaled up
// to the furniture footprint and drawn as a grid of integer-aligned filled
// cells so the pixels stay crisp and blocky (classic pixel-art look).
//
// This mirrors frontend/src/scene/pixelArt.ts (the Pixi production scene) so the
// offline fallback UI renders the same `sofa` and `desk` sprites. Colors here
// are CSS hex strings (the string equivalents of the numeric Pixi colors).

// Palette entries are CSS color strings. `null` = transparent cell.
export type Palette = Record<string, string | null>;

export interface PixelArt {
  rows: string[];
  palette: Palette;
}

// --- Sofa -----------------------------------------------------------------
// Pinkish sofa (base #f08a8a) with a lighter top highlight, darker bottom
// shadow, backrest, two seat cushions and armrests.
const SOFA: PixelArt = {
  palette: {
    ".": null,
    L: "#f7b0b0",
    B: "#f08a8a",
    C: "#f59e9e",
    S: "#d96f6f",
    D: "#c85f5f",
  },
  rows: [
    "...........",
    ".LLLLLLLLL.",
    ".LBBBBBBBL.",
    ".BBBBBBBBB.",
    "BBSCCSCCSBB",
    "BBCCSCCSCBB",
    "BBCCSCCSCBB",
    "BBSCCSCCSBB",
    "BDDDDDDDDDB",
    ".D.......D.",
    ".D.......D.",
  ],
};

// --- Desk + computer ------------------------------------------------------
// Wooden desk (base #d7a86e) with a tabletop, two legs, and a computer on top
// (monitor with a glowing cyan screen, a small stand/base, and a keyboard).
const DESK: PixelArt = {
  palette: {
    ".": null,
    W: "#e6c08c",
    w: "#d7a86e",
    d: "#b98a52",
    m: "#3a3f4b",
    S: "#5bc8e6",
    s: "#bdecf7",
    t: "#5a606e",
    k: "#cfd6df",
  },
  rows: [
    "...mmmmm...",
    "...mSsSm...",
    "...mSSSm...",
    "...mSSSm...",
    "...mmmmm...",
    "....mtm....",
    "...kkkkk...",
    "WWWWWWWWWWW",
    "wwwwwwwwwww",
    "dw.......wd",
    ".w.......w.",
  ],
};

const ART: Record<string, PixelArt> = {
  sofa: SOFA,
  couch: SOFA, // couch shares the sofa sprite (same color family)
  desk: DESK,
};

// hasPixelArt reports whether a furniture type has a programmatic sprite.
export function hasPixelArt(type: string): boolean {
  return type in ART;
}

// drawPixelArt renders the sprite for `type` into the 2D canvas context,
// filling the given footprint (w x h) in the current transform. Each logical
// cell becomes an integer-aligned fillRect so the pixels read crisp. Returns
// false when the type has no sprite (caller should fall back to its default
// shape).
export function drawPixelArt(
  ctx: CanvasRenderingContext2D,
  type: string,
  w: number,
  h: number
): boolean {
  const art = ART[type];
  if (!art) return false;
  const cols = art.rows[0].length;
  const rows = art.rows.length;
  const cw = w / cols;
  const ch = h / rows;
  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for (let r = 0; r < rows; r++) {
    const row = art.rows[r];
    for (let c = 0; c < cols; c++) {
      const color = art.palette[row[c]];
      if (color == null) continue;
      const x0 = Math.round(c * cw);
      const y0 = Math.round(r * ch);
      const x1 = Math.round((c + 1) * cw);
      const y1 = Math.round((r + 1) * ch);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  ctx.imageSmoothingEnabled = prevSmoothing;
  return true;
}
