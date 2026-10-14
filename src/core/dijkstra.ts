/**
 * Dijkstra's algorithm.
 *
 * Always expands the unsettled node with the smallest known distance from the
 * start. Optimal for non-negative costs (validation guarantees positive ones).
 * Complexity O((V + E) log V) with a binary heap and lazy deletion.
 *
 * Closed roads and arcs into blocked intersections are skipped. A blocked
 * start or goal means there is no route.
 */

import type { SearchGraph, SearchResult } from './graph';
import { MinHeap } from './priorityQueue';
import {
  DEFAULT_YIELD_EVERY,
  notFound,
  reconstructPath,
  runSearchSync,
  type SearchRun,
  type SearchRunOptions,
} from './search';

/** Resumable Dijkstra over node indices. See search.ts for how it is driven. */
export function* dijkstraSearch(
  g: SearchGraph,
  start: number,
  goal: number,
  options: SearchRunOptions = {},
): SearchRun {
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const n = g.nodeCount;

  // Local references keep property lookups out of the hot loop.
  const { offsets, target, road } = g.out;
  const roadCost = g.roadCost;
  const roadClosed = g.roadClosed;
  const blocked = g.blocked;

  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const parentRoad = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const explored = new Int32Array(n);
  let exploredCount = 0;

  if (blocked[start] || blocked[goal]) return notFound(explored, 0);

  const heap = new MinHeap<number>();
  dist[start] = 0;
  heap.push(start, 0);

  let sinceYield = 0;

  while (!heap.isEmpty()) {
    const d = heap.peekPriority();
    const u = heap.pop() as number;

    // Lazy deletion: a better entry for u was already processed.
    if (d > dist[u] || settled[u]) continue;
    settled[u] = 1;
    explored[exploredCount++] = u;

    if (u === goal) {
      return { found: true, cost: d, ...reconstructPath(parent, parentRoad, goal), explored: explored.subarray(0, exploredCount) };
    }

    // Relax every open arc u -> v.
    for (let a = offsets[u], end = offsets[u + 1]; a < end; a++) {
      const v = target[a];
      const r = road[a];
      if (roadClosed[r] || blocked[v] || settled[v]) continue;

      const nd = d + roadCost[r];
      if (nd < dist[v]) {
        dist[v] = nd;
        parent[v] = u;
        parentRoad[v] = r;
        heap.push(v, nd);
      }
    }

    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      yield;
    }
  }

  return notFound(explored, exploredCount);
}

/** Runs Dijkstra to completion between two intersection ids. */
export function dijkstra(g: SearchGraph, startId: string, endId: string, options?: SearchRunOptions): SearchResult {
  return runSearchSync(dijkstraSearch, g, startId, endId, options);
}
