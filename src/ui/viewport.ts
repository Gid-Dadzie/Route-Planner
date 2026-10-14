/**
 * World <-> screen transform for the map canvas.
 * screen = world * scale + offset (in CSS pixels).
 */

export interface Viewport {
  scale: number;
  ox: number;
  oy: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 20;

export function screenToWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.ox) / v.scale, y: (sy - v.oy) / v.scale };
}

/** World-space rectangle currently visible, expanded by `marginPx` screen pixels. */
export function visibleWorldBounds(v: Viewport, marginPx = 0): Bounds {
  return {
    minX: (-marginPx - v.ox) / v.scale,
    minY: (-marginPx - v.oy) / v.scale,
    maxX: (v.width + marginPx - v.ox) / v.scale,
    maxY: (v.height + marginPx - v.oy) / v.scale,
  };
}

/** Zooms by `factor`, keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(v: Viewport, sx: number, sy: number, factor: number): void {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = next / v.scale;
  v.ox = sx - (sx - v.ox) * k;
  v.oy = sy - (sy - v.oy) * k;
  v.scale = next;
}

/** Sets scale and offset so `b` fills the viewport with `paddingPx` around it. */
export function fitBounds(v: Viewport, b: Bounds, paddingPx = 48): void {
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const availW = Math.max(v.width - 2 * paddingPx, 1);
  const availH = Math.max(v.height - 2 * paddingPx, 1);
  v.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / w, availH / h)));
  v.ox = (v.width - w * v.scale) / 2 - b.minX * v.scale;
  v.oy = (v.height - h * v.scale) / 2 - b.minY * v.scale;
}

/** Zooms by `factor` around the centre of the view (zoom buttons, + / - keys). */
export function zoomCentered(v: Viewport, factor: number): void {
  zoomAt(v, v.width / 2, v.height / 2, factor);
}

/** Moves the view by (dx, dy) screen pixels (arrow keys). */
export function panBy(v: Viewport, dx: number, dy: number): void {
  v.ox += dx;
  v.oy += dy;
}

/** Puts world point (x, y) at the centre of the view, optionally at a new scale. */
export function centerOn(v: Viewport, x: number, y: number, scale = v.scale): void {
  v.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  v.ox = v.width / 2 - x * v.scale;
  v.oy = v.height / 2 - y * v.scale;
}

/** Bounding box of a set of points, or null for an empty set. */
export function boundsOf(points: Iterable<{ x: number; y: number }>): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * One step of a two-finger pinch: the fingers moved from (a0, b0) to (a1, b1).
 * Zooms by the change in finger distance around the old midpoint, then pans by
 * how far the midpoint moved, so the world point under the fingers stays
 * under them (the map follows the fingers like paper).
 */
export function pinchStep(v: Viewport, a0: ScreenPoint, b0: ScreenPoint, a1: ScreenPoint, b1: ScreenPoint): void {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  if (d0 > 0 && d1 > 0) zoomAt(v, m0.x, m0.y, d1 / d0);
  panBy(v, m1.x - m0.x, m1.y - m0.y);
}
