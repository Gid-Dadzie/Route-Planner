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
