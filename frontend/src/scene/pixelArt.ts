// Programmatic pixel-art sprites for office furniture ("Opsi A": art generated
// in code, no external image files). Each sprite is defined as a small string
// matrix ("art map") where every character maps to a palette color. The matrix
// is scaled up to the furniture footprint and drawn as a grid of integer-aligned
// filled cells so the pixels stay crisp and blocky (classic pixel-art look),
// regardless of the renderer's antialias setting.
//
// Two furniture types use this treatment as the first example: `sofa` and
// `desk` (a table complete with a computer on it). The shared matrices live
// here so the Pixi production scene and the vanilla-canvas fallback scene can
// render identical sprites.

import type { Graphics } from "pixi.js";

// Palette entries are numeric hex (Pixi convention). `null` = transparent cell.
export type Palette = Record<string, number | null>;

export interface PixelArt {
  // Rows of equal length; each character indexes into `palette`.
  rows: string[];
  palette: Palette;
}

// --- Sofa -----------------------------------------------------------------
// Pinkish sofa (base 0xf08a8a) with a lighter top highlight, darker bottom
// shadow, backrest, two seat cushions and armrests.
//   .  transparent        L  light highlight (backrest top)
//   B  body (base pink)    D  dark shadow (bottom / feet)
//   C  cushion face        S  cushion seam / gap
const SOFA: PixelArt = {
  palette: {
    ".": null,
    L: 0xf7b0b0,
    B: 0xf08a8a,
    C: 0xf59e9e,
    S: 0xd96f6f,
    D: 0xc85f5f,
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
// Wooden desk (base 0xd7a86e) seen slightly from the front: a tabletop, two
// legs, and a computer on top (monitor with a glowing cyan screen, a small
// stand/base, and a keyboard).
//   .  transparent        w  wood (tabletop / legs)
//   W  light wood (top highlight)   d  dark wood (underside shadow)
//   m  monitor bezel (dark gray)    S  screen glow (soft cyan)
//   s  screen highlight (bright)    k  keyboard (light gray)
//   t  monitor stand (gray)
const DESK: PixelArt = {
  palette: {
    ".": null,
    W: 0xe6c08c,
    w: 0xd7a86e,
    d: 0xb98a52,
    m: 0x3a3f4b,
    S: 0x5bc8e6,
    s: 0xbdecf7,
    t: 0x5a606e,
    k: 0xcfd6df,
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

// drawPixelArt renders the sprite for `type` into the Pixi Graphics `g`,
// filling the given footprint (w x h). Each logical cell becomes an
// integer-aligned filled rect so the pixels read crisp. Returns false when the
// type has no sprite (caller should fall back to its default shape).
export function drawPixelArt(g: Graphics, type: string, w: number, h: number): boolean {
  const art = ART[type];
  if (!art) return false;
  const cols = art.rows[0].length;
  const rows = art.rows.length;
  const cw = w / cols;
  const ch = h / rows;
  for (let r = 0; r < rows; r++) {
    const row = art.rows[r];
    for (let c = 0; c < cols; c++) {
      const color = art.palette[row[c]];
      if (color == null) continue;
      // Integer-align each cell (and extend to the next cell edge) so adjacent
      // cells tile seamlessly without antialiased seams.
      const x0 = Math.round(c * cw);
      const y0 = Math.round(r * ch);
      const x1 = Math.round((c + 1) * cw);
      const y1 = Math.round((r + 1) * ch);
      g.rect(x0, y0, x1 - x0, y1 - y0).fill(color);
    }
  }
  return true;
}
