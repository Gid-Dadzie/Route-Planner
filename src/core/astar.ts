/**
 * A* search.
 *
 * Dijkstra with a goal-directed priority: f(n) = g(n) + h(n), where g is the
 * cost from the start and h estimates the cost remaining to the goal. With the
 * default Euclidean heuristic (admissible and consistent, see heuristics.ts)
 * the first time the goal is popped its cost is optimal, and each node needs
 * to be expanded at most once, so a closed set is safe.
 *
 * Same conventions as Dijkstra: lazy deletion in the heap, closed roads and
 * arcs into blocked intersections skipped, blocked start or goal = no route,
 * cooperative pauses every `yieldEvery` expansions.
 */

import type { SearchGraph, SearchResult } from './graph';
import { getHeuristic } from './heuristics';
import { MinHeap } from './priorityQueue';
import {
  DEFAULT_YIELD_EVERY,
  notFound,
  reconstructPath,
  runSearchSync,
  type SearchRun,
  type SearchRunOptions,
} from './search';

/** Resumable A* over node indices. */
export function* astarSearch(g: SearchGraph, start: number, goal: number, options: SearchRunOptions = {}): SearchRun {
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const h = getHeuristic(options.heuristic ?? 'euclidean').fn;
  const n = g.nodeCount;

  const { offsets, target, road } = g.out;
  const roadCost = g.roadCost;
  const roadClosed = g.roadClosed;
  const blocked = g.blocked;
  const xs = g.x;
  const ys = g.y;
  const gx = xs[goal];
  const gy = ys[goal];

  const gScore = new Float64Array(n).fill(Infinity);
  /** Heuristic per node, computed on first use (-1 = not yet computed). */
  const hCache = new Float64Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const parentRoad = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const explored = new Int32Array(n);
  let exploredCount = 0;

  if (blocked[start] || blocked[goal]) return notFound(explored, 0);

  const heuristic = (v: number): number => {
    let hv = hCache[v];
    if (hv < 0) {
      hv = h(xs[v], ys[v], gx, gy);
      hCache[v] = hv;
    }
    return hv;
  };

  const heap = new MinHeap<number>();
  gScore[start] = 0;
  heap.push(start, heuristic(start));

  let sinceYield = 0;

  while (!heap.isEmpty()) {
    const u = heap.pop() as number;
    // Lazy deletion: skip duplicates of nodes already expanded.
    if (closed[u]) continue;
    closed[u] = 1;
    explored[exploredCount++] = u;

    if (u === goal) {
      return { found: true, cost: gScore[goal], ...reconstructPath(parent, parentRoad, goal), explored: explored.subarray(0, exploredCount) };
    }

    const gu = gScore[u];
    for (let a = offsets[u], end = offsets[u + 1]; a < end; a++) {
      const v = target[a];
      const r = road[a];
      if (roadClosed[r] || blocked[v] || closed[v]) continue;

      const ng = gu + roadCost[r];
      if (ng < gScore[v]) {
        gScore[v] = ng;
        parent[v] = u;
        parentRoad[v] = r;
        heap.push(v, ng + heuristic(v));
      }
    }

    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      yield;
    }
  }

  return notFound(explored, exploredCount);
}

/** Runs A* to completion between two intersection ids. */
export function astar(g: SearchGraph, startId: string, endId: string, options?: SearchRunOptions): SearchResult {
  return runSearchSync(astarSearch, g, startId, endId, options);
}
