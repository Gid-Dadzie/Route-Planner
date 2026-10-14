/**
 * Timeline for the route animation: first the exploration wave (explored nodes
 * revealed in the order the search settled them), then the route line drawn
 * from start to end.
 *
 * Pure functions of elapsed time, so the canvas just asks "what should frame t
 * look like?" and the timing is unit-testable.
 */

/** The wave lasts ~5 ms per explored node, clamped to this range. */
export const WAVE_MIN_MS = 1000;
export const WAVE_MAX_MS = 2500;
export const ROUTE_DRAW_MS = 450;
/** Fraction of the explored list shown as the bright frontier band. */
const FRONTIER_FRACTION = 0.06;

export interface AnimationFrame {
  /**
   * How many explored nodes are visible. On a 2D map the explored count grows
   * with the square of the wave radius, so revealing count ~ t^2 makes the
   * wavefront move outward at a steady speed.
   */
  revealed: number;
  /** How many of the most recently revealed nodes form the bright frontier. */
  frontier: number;
  /** Portion of the route polyline drawn, 0..1. */
  routeProgress: number;
  done: boolean;
}

export function waveDurationMs(exploredCount: number): number {
  return Math.min(WAVE_MAX_MS, Math.max(WAVE_MIN_MS, exploredCount * 5));
}

/** The completed state: everything revealed, full route, no frontier. */
export function finalFrame(exploredCount: number): AnimationFrame {
  return { revealed: exploredCount, frontier: 0, routeProgress: 1, done: true };
}

export function animationFrameAt(exploredCount: number, elapsedMs: number): AnimationFrame {
  const wave = waveDurationMs(exploredCount);
  if (elapsedMs >= wave + ROUTE_DRAW_MS) return finalFrame(exploredCount);

  const waveT = Math.min(1, Math.max(0, elapsedMs / wave));
  const revealed = Math.round(exploredCount * waveT * waveT);
  const frontier = waveT < 1 ? Math.min(revealed, Math.max(1, Math.round(exploredCount * FRONTIER_FRACTION))) : 0;
  const routeProgress = Math.min(1, Math.max(0, (elapsedMs - wave) / ROUTE_DRAW_MS));
  return { revealed, frontier, routeProgress: easeInOutQuad(routeProgress), done: false };
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}
