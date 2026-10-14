/**
 * Unweighted graph traversal (BFS / DFS) for support tasks, not routing:
 *
 * - Reachability: can the goal be reached at all? A BFS has no heap, so it
 *   answers several times faster than a weighted search and lets the worker
 *   report "no route" without running one.
 * - Cut-off regions: when there is no route, which part of the map is
 *   separated, and which closed roads, obstacles or one-way roads form the
 *   barrier around it.
 * - Validation: isolated intersections and disconnected regions (DFS).
 *
 * Arc rules match the searches exactly: a forward step u -> v is allowed when
 * its road is open and v is not blocked; blocked intersections are never part
 * of any route.
 */

import type { SearchGraph } from './graph';

export interface Reach {
  /** 1 for every node in the set. */
  inSet: Uint8Array;
  /** Nodes in BFS order. */
  order: Int32Array;
  count: number;
}

/** Every node reachable from `start` (forward BFS). Empty if start is blocked. */
export function reachableFrom(g: SearchGraph, start: number, stopAt = -1): Reach {
  const { offsets, target, road } = g.out;
  const inSet = new Uint8Array(g.nodeCount);
  const order = new Int32Array(g.nodeCount);
  let head = 0;
  let tail = 0;
  if (!g.blocked[start]) {
    inSet[start] = 1;
    order[tail++] = start;
  }
  while (head < tail) {
    const u = order[head++];
    if (u === stopAt) break;
    for (let a = offsets[u], end = offsets[u + 1]; a < end; a++) {
      const v = target[a];
      if (inSet[v] || g.roadClosed[road[a]] || g.blocked[v]) continue;
      inSet[v] = 1;
      order[tail++] = v;
    }
  }
  return { inSet, order: order.subarray(0, tail), count: tail };
}

/** Every node from which `goal` can be reached (BFS over the reversed graph). */
export function reachingTo(g: SearchGraph, goal: number): Reach {
  const { offsets, target, road } = g.in;
  const inSet = new Uint8Array(g.nodeCount);
  const order = new Int32Array(g.nodeCount);
  let head = 0;
  let tail = 0;
  if (!g.blocked[goal]) {
    inSet[goal] = 1;
    order[tail++] = goal;
  }
  while (head < tail) {
    const v = order[head++];
    // Reversed arc: the forward arc u -> v is usable if its road is open and
    // u is not blocked (v is already known to be enterable).
    for (let a = offsets[v], end = offsets[v + 1]; a < end; a++) {
      const u = target[a];
      if (inSet[u] || g.roadClosed[road[a]] || g.blocked[u]) continue;
      inSet[u] = 1;
      order[tail++] = u;
    }
  }
  return { inSet, order: order.subarray(0, tail), count: tail };
}

/** True if some route from start to goal exists. Stops as soon as the goal is found. */
export function canReach(g: SearchGraph, start: number, goal: number): boolean {
  if (g.blocked[start] || g.blocked[goal]) return false;
  return reachableFrom(g, start, goal).inSet[goal] === 1;
}

export interface CutOff {
  reason: 'blocked-start' | 'blocked-end' | 'unreachable';
  /** Which side is highlighted: the smaller of "reachable from start" and "can reach the end". */
  side: 'start' | 'end';
  /** Nodes of the highlighted region. */
  region: Int32Array;
  /** Roads on the region's boundary that stop you crossing it. */
  barrierRoads: number[];
  /** Blocked intersections on the region's boundary (or the blocked endpoint). */
  barrierNodes: number[];
  /** Size of the start side (nodes reachable from the start). */
  startSideCount: number;
}

/**
 * Explains a missing route. Highlights the smaller of the two separated sides
 * (usually the pocket that has been cut off) and collects the barriers on its
 * boundary: closed roads, blocked neighbours, and one-way roads that only lead
 * the wrong way across it. Returns null if a route does exist.
 */
export function explainNoRoute(g: SearchGraph, start: number, goal: number, fromStart?: Reach): CutOff | null {
  if (g.blocked[start]) return { reason: 'blocked-start', side: 'start', region: Int32Array.of(start), barrierRoads: [], barrierNodes: [start], startSideCount: 0 };
  if (g.blocked[goal]) {
    const startSide = fromStart ?? reachableFrom(g, start);
    return { reason: 'blocked-end', side: 'end', region: Int32Array.of(goal), barrierRoads: [], barrierNodes: [goal], startSideCount: startSide.count };
  }

  const startSide = fromStart ?? reachableFrom(g, start);
  if (startSide.inSet[goal]) return null;
  const endSide = reachingTo(g, goal);

  // Highlight the smaller side; its boundary is the tighter ring of barriers.
  const side: 'start' | 'end' = startSide.count <= endSide.count ? 'start' : 'end';
  const R = side === 'start' ? startSide : endSide;

  const barrierRoads = new Set<number>();
  const barrierNodes = new Set<number>();
  for (let i = 0; i < R.count; i++) {
    const u = R.order[i];
    // Roads leaving the region (forward arcs u -> v, v outside).
    for (let a = g.out.offsets[u], end = g.out.offsets[u + 1]; a < end; a++) {
      const v = g.out.target[a];
      if (R.inSet[v]) continue;
      const r = g.out.road[a];
      if (g.roadClosed[r]) barrierRoads.add(r);
      else if (g.blocked[v]) barrierNodes.add(v);
      // An open arc leaving the END side is a one-way road pointing away from it:
      // you can leave the pocket but not enter it.
      else if (side === 'end') barrierRoads.add(r);
    }
    // Roads entering the region (forward arcs v -> u, v outside).
    for (let a = g.in.offsets[u], end = g.in.offsets[u + 1]; a < end; a++) {
      const v = g.in.target[a];
      if (R.inSet[v]) continue;
      const r = g.in.road[a];
      if (g.roadClosed[r]) barrierRoads.add(r);
      else if (g.blocked[v]) barrierNodes.add(v);
      // An open arc entering the START side is a one-way road pointing into it:
      // it brought you nowhere and there is no way back out.
      else if (side === 'start') barrierRoads.add(r);
    }
  }

  return {
    reason: 'unreachable',
    side,
    region: R.order,
    barrierRoads: [...barrierRoads],
    barrierNodes: [...barrierNodes],
    startSideCount: startSide.count,
  };
}

export interface NetworkReport {
  /** Connected regions among usable intersections (open roads, ignoring direction). */
  regions: number;
  /** Size of the largest region. */
  largestRegion: number;
  /** Usable intersections with no open road to another usable intersection. */
  isolated: number[];
  /** Blocked intersections (excluded from the counts above). */
  blocked: number;
}

/**
 * Validation pass: iterative DFS over open roads, treating every road as
 * two-way, to count disconnected regions and find isolated intersections.
 */
export function analyzeNetwork(g: SearchGraph): NetworkReport {
  const n = g.nodeCount;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const isolated: number[] = [];
  let regions = 0;
  let largestRegion = 0;
  let blocked = 0;

  for (let s = 0; s < n; s++) {
    if (g.blocked[s]) {
      blocked++;
      continue;
    }
    if (seen[s]) continue;
    regions++;
    let size = 0;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top > 0) {
      const u = stack[--top];
      size++;
      // Undirected: follow arcs in both directions.
      for (const adj of [g.out, g.in]) {
        for (let a = adj.offsets[u], end = adj.offsets[u + 1]; a < end; a++) {
          const v = adj.target[a];
          if (seen[v] || g.blocked[v] || g.roadClosed[adj.road[a]]) continue;
          seen[v] = 1;
          stack[top++] = v;
        }
      }
    }
    if (size === 1) isolated.push(s);
    largestRegion = Math.max(largestRegion, size);
  }

  return { regions, largestRegion, isolated, blocked };
}
