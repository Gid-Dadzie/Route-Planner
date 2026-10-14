/**
 * Heuristics for A*: estimates of the remaining cost from a node to the goal.
 *
 * A* returns an optimal route only if the heuristic is admissible: it never
 * overestimates the true remaining cost. Here every road's cost is
 * distance x multiplier with distance >= straight-line length and multiplier >= 1,
 * so cost >= straight-line length and:
 *
 * - Euclidean (straight-line) distance is admissible, and also consistent
 *   (h(u) <= cost(u, v) + h(v) by the triangle inequality), so A* with a closed
 *   set is optimal. This is the default.
 * - Manhattan distance |dx| + |dy| can be up to sqrt(2) times the straight-line
 *   distance, so on diagonal roads it OVERESTIMATES and A* may return a longer
 *   route. It is admissible only when every road is axis-aligned (a pure grid).
 *   Offered as an option to demonstrate the trade-off: it is more aggressive,
 *   so it often explores fewer nodes, but optimality is not guaranteed.
 */

export type HeuristicId = 'euclidean' | 'manhattan';

/** Estimated remaining cost from (ax, ay) to (bx, by). */
export type HeuristicFn = (ax: number, ay: number, bx: number, by: number) => number;

export interface HeuristicInfo {
  id: HeuristicId;
  label: string;
  /** True if it never overestimates on any valid network. */
  admissible: boolean;
  description: string;
  fn: HeuristicFn;
}

export function euclideanHeuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function manhattanHeuristic(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export const HEURISTICS: readonly HeuristicInfo[] = [
  {
    id: 'euclidean',
    label: 'Euclidean',
    admissible: true,
    description: 'Straight-line distance. Never overestimates, so A* always finds the optimal route.',
    fn: euclideanHeuristic,
  },
  {
    id: 'manhattan',
    label: 'Manhattan',
    admissible: false,
    description: 'Grid distance |dx| + |dy|. Overestimates on diagonal roads, so the route may not be optimal.',
    fn: manhattanHeuristic,
  },
];

export function getHeuristic(id: HeuristicId): HeuristicInfo {
  return HEURISTICS.find((h) => h.id === id) as HeuristicInfo;
}
