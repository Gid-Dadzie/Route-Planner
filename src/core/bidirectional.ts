/**
 * Bidirectional Dijkstra.
 *
 * Two searches run at once: forward from the start over the graph, and
 * backward from the goal over the reversed graph (`g.in`), so one-way roads
 * are respected in both directions. Each step expands the side whose queue is
 * smaller, which keeps the two "search circles" balanced.
 *
 * Correctness details (the parts that are easy to get wrong):
 *
 * - The first node settled by both sides is NOT necessarily on the optimal
 *   path. Instead, whenever a relaxed arc u -> v connects the two sides
 *   (v already has a label from the other side), the candidate total
 *   mu = distF[u] + cost(u, v) + distB[v] is recorded, together with that arc.
 * - Stop only when topF + topB >= mu, where topF / topB are the smallest
 *   priorities left in each queue. Any path not yet seen must cost at least
 *   topF + topB, so mu is optimal at that point. Stale heap entries can only
 *   make a top priority look smaller, which delays the stop but never makes
 *   it premature. An empty queue has top = Infinity, so if one side runs dry
 *   without the two meeting, the loop ends with mu = Infinity: no route.
 * - The route is rebuilt from the recorded arc: forward parents back to the
 *   start, then backward parents on to the goal.
 *
 * Same conventions as the other searches: lazy deletion, closed roads and
 * blocked intersections skipped, cooperative pauses every `yieldEvery`
 * expansions (counting both sides).
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

/** Values of `exploredSides`. */
export const FORWARD = 0;
export const BACKWARD = 1;

export function* bidirectionalSearch(g: SearchGraph, start: number, goal: number, options: SearchRunOptions = {}): SearchRun {
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const n = g.nodeCount;
  const roadCost = g.roadCost;
  const roadClosed = g.roadClosed;
  const blocked = g.blocked;

  const explored = new Int32Array(n);
  const exploredSides = new Uint8Array(n);
  /** 1 once a node is in `explored` (a node settled by both sides is listed once). */
  const listed = new Uint8Array(n);
  let exploredCount = 0;

  if (blocked[start] || blocked[goal]) return notFound(explored, 0);
  if (start === goal) {
    explored[0] = start;
    return { found: true, cost: 0, path: [start], pathRoads: [], explored: explored.subarray(0, 1), exploredSides: exploredSides.subarray(0, 1) };
  }

  // Forward side: distances from the start; parent = previous node on the way from the start.
  const distF = new Float64Array(n).fill(Infinity);
  const parentF = new Int32Array(n).fill(-1);
  const roadF = new Int32Array(n).fill(-1);
  const settledF = new Uint8Array(n);
  const heapF = new MinHeap<number>();

  // Backward side: distances TO the goal; parent = next node on the way to the goal.
  const distB = new Float64Array(n).fill(Infinity);
  const parentB = new Int32Array(n).fill(-1);
  const roadB = new Int32Array(n).fill(-1);
  const settledB = new Uint8Array(n);
  const heapB = new MinHeap<number>();

  distF[start] = 0;
  heapF.push(start, 0);
  distB[goal] = 0;
  heapB.push(goal, 0);

  /** Best complete path found so far, as the arc a -> b joining the sides. */
  let mu = Infinity;
  let meetA = -1;
  let meetB = -1;
  let meetRoad = -1;

  let sinceYield = 0;

  for (;;) {
    if (heapF.peekPriority() + heapB.peekPriority() >= mu) break;

    // Both queues are non-empty here (an empty one has top = Infinity and ends
    // the loop above). Expand the side with the smaller queue; ties go forward.
    const forward = heapF.size <= heapB.size;
    const heap = forward ? heapF : heapB;
    const dist = forward ? distF : distB;
    const other = forward ? distB : distF;
    const settled = forward ? settledF : settledB;
    const parent = forward ? parentF : parentB;
    const parentRoad = forward ? roadF : roadB;
    const adj = forward ? g.out : g.in;

    const d = heap.peekPriority();
    const u = heap.pop() as number;
    if (d > dist[u] || settled[u]) continue; // stale entry
    settled[u] = 1;
    if (!listed[u]) {
      listed[u] = 1;
      explored[exploredCount] = u;
      exploredSides[exploredCount++] = forward ? FORWARD : BACKWARD;
    }

    for (let a = adj.offsets[u], end = adj.offsets[u + 1]; a < end; a++) {
      const v = adj.target[a];
      const r = adj.road[a];
      // Forward arc u -> v needs v enterable; reversed arc (v -> u forward) needs v usable too.
      if (roadClosed[r] || blocked[v]) continue;

      const nd = d + roadCost[r];
      if (nd < dist[v] && !settled[v]) {
        dist[v] = nd;
        parent[v] = u;
        parentRoad[v] = r;
        heap.push(v, nd);
      }
      // Does this arc connect the two searches?
      if (other[v] < Infinity) {
        const total = nd + other[v];
        if (total < mu) {
          mu = total;
          meetRoad = r;
          // Orient the joining arc forward: meetA is on the start's side.
          meetA = forward ? u : v;
          meetB = forward ? v : u;
        }
      }
    }

    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      yield;
    }
  }

  const exploredOut = explored.subarray(0, exploredCount);
  if (mu === Infinity) return { ...notFound(explored, exploredCount), exploredSides: exploredSides.subarray(0, exploredCount) };

  // start ... meetA (forward parents), then meetB ... goal (backward parents).
  const head = reconstructPath(parentF, roadF, meetA);
  const path = head.path;
  const pathRoads = head.pathRoads;
  pathRoads.push(meetRoad);
  for (let v = meetB; v !== -1; v = parentB[v]) {
    path.push(v);
    if (parentB[v] !== -1) pathRoads.push(roadB[v]);
  }

  return { found: true, cost: mu, path, pathRoads, explored: exploredOut, exploredSides: exploredSides.subarray(0, exploredCount) };
}

/** Runs bidirectional search to completion between two intersection ids. */
export function bidirectional(g: SearchGraph, startId: string, endId: string, options?: SearchRunOptions): SearchResult {
  return runSearchSync(bidirectionalSearch, g, startId, endId, options);
}
