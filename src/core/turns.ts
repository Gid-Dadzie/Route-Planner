/**
 * Turn restrictions: "no turn from road r1 onto road r2 at intersection v"
 * (for example no left turn, or no U-turn on a two-way road).
 *
 * A node-based search cannot enforce these. Whether you may leave v by r2
 * depends on the road you arrived by, but Dijkstra keeps one label per node:
 * the cheapest arrival at v may use the banned turn while a dearer arrival
 * allows it, and the node-based search would throw the dearer one away.
 *
 * The standard fix is to search the *line graph* (edge-based graph):
 *
 * - every directed arc a = (u -> v) of the base graph becomes a node of the
 *   line graph, meaning "just arrived at v by arc a", placed at v;
 * - an allowed turn a -> b at v (b leaves v) becomes a line-graph arc whose
 *   cost is the cost of b, so its road index is b's road;
 * - a source node S (at the start) has an arc to every arc leaving the start,
 *   and every arc entering the goal has a zero-cost arc to a sink node T.
 *
 * Shortest S -> T paths in the line graph are exactly the shortest base routes
 * that use no banned turn. Because the line graph is an ordinary SearchGraph,
 * Dijkstra, A* (Euclidean is still admissible: every line-graph node sits at
 * the head of its arc), bidirectional search, D* Lite and Yen run on it
 * unchanged. The line graph shares road indices with the base graph, so
 * closures and traffic are read from per-road arrays that `refreshTurnGraph`
 * copies before each use; only the topology is cached.
 *
 * Restrictions are not applied across a waypoint: each leg starts fresh.
 */

import type { SearchGraph } from './graph';
import type { IndexedSearchResult } from './search';

export interface TurnRestriction {
  /** Road the vehicle arrives by. */
  fromRoad: string;
  /** Intersection where the turn happens (an endpoint of both roads). */
  via: string;
  /** Road the vehicle may not continue onto. Equal to fromRoad for a U-turn ban. */
  toRoad: string;
}

/** Stable key for a restriction (used as a Map key in the store). */
export function turnKey(t: TurnRestriction): string {
  return `${t.fromRoad}>${t.via}>${t.toRoad}`;
}

/** Banned turns in index space. */
export interface BannedTurns {
  /** Number of restrictions that matched existing roads and intersections. */
  readonly count: number;
  /** 1 if at least one banned turn happens at this node (skips set lookups elsewhere). */
  readonly viaHasBan: Uint8Array;
  has(fromRoad: number, via: number, toRoad: number): boolean;
}

/**
 * Resolves restrictions against a compiled graph. Restrictions that name
 * unknown roads or intersections, or roads that do not meet at `via`, are
 * ignored (they cannot affect any route).
 */
export function compileTurnRestrictions(g: SearchGraph, list: readonly TurnRestriction[]): BannedTurns {
  const keys = new Set<number>();
  const viaHasBan = new Uint8Array(g.nodeCount);
  const R = g.roadCount;
  const key = (from: number, via: number, to: number) => (from * g.nodeCount + via) * R + to;
  const touches = (r: number, v: number) => g.roadFrom[r] === v || g.roadTo[r] === v;

  for (const t of list) {
    const from = g.roadIndex.get(t.fromRoad);
    const via = g.nodeIndex.get(t.via);
    const to = g.roadIndex.get(t.toRoad);
    if (from === undefined || via === undefined || to === undefined) continue;
    if (!touches(from, via) || !touches(to, via)) continue;
    keys.add(key(from, via, to));
    viaHasBan[via] = 1;
  }

  return {
    count: keys.size,
    viaHasBan,
    has: (from, via, to) => viaHasBan[via] === 1 && keys.has(key(from, via, to)),
  };
}

/** A line graph for one (start, goal) pair. */
export interface TurnGraph {
  /** The derived graph. Its id arrays are empty: map results with `turnResultToBase`. */
  readonly graph: SearchGraph;
  /** Line-graph node of the start (S) and of the goal (T). */
  readonly source: number;
  readonly sink: number;
  readonly base: SearchGraph;
  readonly start: number;
  readonly goal: number;
}

/** Builds the line graph of `base` for one query. O(sum over v of indeg(v) * outdeg(v)). */
export function buildTurnGraph(base: SearchGraph, banned: BannedTurns, start: number, goal: number): TurnGraph {
  const { offsets, target, road } = base.out;
  const arcCount = target.length;
  const S = arcCount;
  const T = arcCount + 1;
  const n = arcCount + 2;
  const virtualRoad = base.roadCount;

  /** Calls fn(next, roadIndex) for every allowed line-graph arc out of node `p`. */
  const forEachArc = (p: number, fn: (next: number, r: number) => void): void => {
    if (p === T) return;
    const v = p === S ? start : target[p];
    const fromRoad = p === S ? -1 : road[p];
    const check = fromRoad >= 0 && banned.viaHasBan[v] === 1;
    for (let b = offsets[v], end = offsets[v + 1]; b < end; b++) {
      if (check && banned.has(fromRoad, v, road[b])) continue;
      fn(b, road[b]);
    }
    if (v === goal) fn(T, virtualRoad);
  };

  // Pass 1: degrees.
  const outDeg = new Int32Array(n);
  const inDeg = new Int32Array(n);
  let total = 0;
  for (let p = 0; p < n; p++) {
    forEachArc(p, (q) => {
      outDeg[p]++;
      inDeg[q]++;
      total++;
    });
  }

  // Pass 2: CSR fill (forward and reversed).
  const outOffsets = prefixSums(outDeg);
  const inOffsets = prefixSums(inDeg);
  const outTarget = new Int32Array(total);
  const outRoad = new Int32Array(total);
  const inTarget = new Int32Array(total);
  const inRoad = new Int32Array(total);
  const outCursor = outOffsets.slice(0, n);
  const inCursor = inOffsets.slice(0, n);
  for (let p = 0; p < n; p++) {
    forEachArc(p, (q, r) => {
      const o = outCursor[p]++;
      outTarget[o] = q;
      outRoad[o] = r;
      const i = inCursor[q]++;
      inTarget[i] = p;
      inRoad[i] = r;
    });
  }

  const R = base.roadCount + 1;
  const graph: SearchGraph = {
    nodeCount: n,
    roadCount: R,
    nodeIds: [],
    nodeIndex: new Map(),
    x: new Float64Array(n),
    y: new Float64Array(n),
    blocked: new Uint8Array(n),
    roadIds: [],
    roadIndex: new Map(),
    // Not read by the searches; endpoints of line-graph arcs live in the CSR arrays.
    roadFrom: new Int32Array(R),
    roadTo: new Int32Array(R),
    roadDistance: new Float64Array(R),
    roadTraffic: new Uint8Array(R),
    roadClosed: new Uint8Array(R),
    roadCost: new Float64Array(R),
    out: { offsets: outOffsets, target: outTarget, road: outRoad },
    in: { offsets: inOffsets, target: inTarget, road: inRoad },
  };

  const tg: TurnGraph = { graph, source: S, sink: T, base, start, goal };
  refreshTurnGraph(tg);
  return tg;
}

/**
 * Copies the base graph's dynamic state (closures, traffic, costs, obstacles,
 * positions) into the line graph. O(arcs + roads); call before every search.
 */
export function refreshTurnGraph(tg: TurnGraph): void {
  const { base, graph, source: S, sink: T } = tg;
  const target = base.out.target;
  // The arrays are typed as readonly references; their contents are writable.
  const x = graph.x;
  const y = graph.y;
  const blocked = graph.blocked;
  for (let a = 0; a < target.length; a++) {
    const v = target[a];
    x[a] = base.x[v];
    y[a] = base.y[v];
    blocked[a] = base.blocked[v];
  }
  x[S] = base.x[tg.start];
  y[S] = base.y[tg.start];
  blocked[S] = base.blocked[tg.start];
  x[T] = base.x[tg.goal];
  y[T] = base.y[tg.goal];
  blocked[T] = base.blocked[tg.goal];

  const R = base.roadCount;
  graph.roadCost.set(base.roadCost);
  graph.roadClosed.set(base.roadClosed);
  graph.roadDistance.set(base.roadDistance);
  graph.roadTraffic.set(base.roadTraffic);
  // The virtual "arrive at the goal" road: free and always open.
  graph.roadCost[R] = 0;
  graph.roadClosed[R] = 0;
  graph.roadDistance[R] = 0;
  graph.roadTraffic[R] = 1;
}

/** Maps a line-graph path (S, a1, ..., ak[, T]) to base nodes and roads. */
export function turnPathToBase(tg: TurnGraph, path: readonly number[]): { path: number[]; pathRoads: number[] } {
  if (path.length === 0) return { path: [], pathRoads: [] };
  const { target, road } = tg.base.out;
  const nodes = [tg.start];
  const roads: number[] = [];
  for (const p of path) {
    if (p === tg.source || p === tg.sink) continue;
    nodes.push(target[p]);
    roads.push(road[p]);
  }
  return { path: nodes, pathRoads: roads };
}

/**
 * Converts a line-graph search result to base-graph indices. Explored states
 * are mapped to their intersections and de-duplicated (several arrivals at
 * one intersection count once), keeping `exploredSides` aligned.
 */
export function turnResultToBase(tg: TurnGraph, r: IndexedSearchResult): IndexedSearchResult {
  const target = tg.base.out.target;
  const seen = new Uint8Array(tg.base.nodeCount);
  const explored = new Int32Array(Math.min(r.explored.length, tg.base.nodeCount));
  const sides = r.exploredSides ? new Uint8Array(explored.length) : null;
  let count = 0;
  for (let i = 0; i < r.explored.length; i++) {
    const p = r.explored[i];
    const v = p === tg.source ? tg.start : p === tg.sink ? tg.goal : target[p];
    if (seen[v]) continue;
    seen[v] = 1;
    if (sides) sides[count] = r.exploredSides![i];
    explored[count++] = v;
  }
  return {
    found: r.found,
    cost: r.cost,
    ...turnPathToBase(tg, r.path),
    explored: explored.subarray(0, count),
    ...(sides ? { exploredSides: sides.subarray(0, count) } : {}),
  };
}

function prefixSums(degree: Int32Array): Int32Array {
  const offsets = new Int32Array(degree.length + 1);
  for (let i = 0; i < degree.length; i++) offsets[i + 1] = offsets[i] + degree[i];
  return offsets;
}

// ---------------------------------------------------------------------------
// Geometry helpers for the editor: classify a turn as left / right / straight.
// ---------------------------------------------------------------------------

export type TurnKind = 'straight' | 'left' | 'right' | 'uturn';

/**
 * Classifies arriving at (vx, vy) from (ax, ay) and leaving toward (bx, by).
 * Screen coordinates: y grows downward, so a counter-clockwise turn on screen
 * (a left turn) has a negative cross product.
 */
export function classifyTurn(ax: number, ay: number, vx: number, vy: number, bx: number, by: number): TurnKind {
  const d1x = vx - ax, d1y = vy - ay;
  const d2x = bx - vx, d2y = by - vy;
  const angle = Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y); // -pi..pi
  const deg = (angle * 180) / Math.PI;
  if (Math.abs(deg) <= 30) return 'straight';
  if (Math.abs(deg) >= 150) return 'uturn';
  return deg < 0 ? 'left' : 'right';
}
