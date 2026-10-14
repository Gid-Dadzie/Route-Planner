/**
 * Alternative routes: Yen's k-shortest loopless paths (1971), with Lawler's
 * refinement.
 *
 * The best route is found first. Each further route deviates from an accepted
 * one at some "spur" node: keep the accepted route's prefix (the root) up to
 * the spur, forbid the arcs that any accepted route with the same root takes
 * out of the spur, forbid revisiting root nodes (so routes stay loopless), and
 * search spur -> goal. Every spur result is a candidate; the cheapest unseen
 * candidate becomes the next route.
 *
 * Lawler: a route that deviated at index i shares its first i arcs with its
 * parent, whose spurs before i were already tried, so its own spurs start at i.
 *
 * Spur searches are A* with the Euclidean heuristic (admissible here, see
 * heuristics.ts), with bans kept in per-arc and per-node masks. Because bans
 * are per arc, not per road, this also runs unchanged on the line graph used
 * for turn restrictions (turns.ts).
 *
 * Cost: up to (path length) spur searches per extra route. The worker runs it
 * in time slices like any other search, so it never blocks the UI.
 */

import type { SearchGraph } from './graph';
import { MinHeap } from './priorityQueue';
import { DEFAULT_YIELD_EVERY } from './search';

export interface RankedPath {
  /** Node indices, start to goal. */
  path: number[];
  /** CSR arc indices (into g.out) along the path. */
  arcs: number[];
  /** Road index for each arc. */
  pathRoads: number[];
  cost: number;
}

export interface KShortestResult {
  /** Up to k routes, cheapest first. Empty when no route exists. */
  paths: RankedPath[];
  /** Spur searches run (a measure of the work done). */
  spurSearches: number;
  /** Node expansions over all searches. */
  expansions: number;
}

/**
 * A* that can be told to avoid specific arcs and nodes. Arrays are reused
 * between searches: an entry is valid only if its stamp equals the current
 * search's stamp, so starting a search costs O(1) instead of O(n).
 */
class MaskedAStar {
  private readonly dist: Float64Array;
  private readonly parentArc: Int32Array;
  private readonly parentNode: Int32Array;
  private readonly seen: Uint32Array;
  private readonly done: Uint32Array;
  private stamp = 0;
  readonly bannedArc: Uint8Array;
  readonly bannedNode: Uint8Array;
  expansions = 0;
  private sinceYield = 0;

  constructor(
    private readonly g: SearchGraph,
    private readonly goal: number,
    private readonly yieldEvery: number,
  ) {
    const n = g.nodeCount;
    this.dist = new Float64Array(n);
    this.parentArc = new Int32Array(n);
    this.parentNode = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.done = new Uint32Array(n);
    this.bannedArc = new Uint8Array(g.out.target.length);
    this.bannedNode = new Uint8Array(n);
  }

  /** Cheapest route from `from` to the goal respecting the masks, or null. */
  *search(from: number): Generator<void, { arcs: number[]; cost: number } | null, void> {
    const g = this.g;
    const goal = this.goal;
    const { offsets, target, road } = g.out;
    const { roadCost, roadClosed, blocked, x, y } = g;
    const gx = x[goal];
    const gy = y[goal];
    const h = (v: number) => Math.hypot(x[v] - gx, y[v] - gy);
    const { dist, parentArc, parentNode, seen, done, bannedArc, bannedNode } = this;
    const stamp = ++this.stamp;

    if (blocked[from] || blocked[goal]) return null;
    const heap = new MinHeap<number>();
    seen[from] = stamp;
    dist[from] = 0;
    heap.push(from, h(from));

    while (!heap.isEmpty()) {
      const u = heap.pop() as number;
      if (done[u] === stamp) continue;
      done[u] = stamp;
      this.expansions++;
      if (u === goal) {
        const arcs: number[] = [];
        for (let v = goal; v !== from; v = parentNode[v]) arcs.push(parentArc[v]);
        arcs.reverse();
        let cost = 0;
        for (const a of arcs) cost += roadCost[road[a]];
        return { arcs, cost };
      }
      const du = dist[u];
      for (let a = offsets[u], end = offsets[u + 1]; a < end; a++) {
        const v = target[a];
        const r = road[a];
        if (bannedArc[a] || bannedNode[v] || roadClosed[r] || blocked[v] || done[v] === stamp) continue;
        const nd = du + roadCost[r];
        if (seen[v] !== stamp || nd < dist[v]) {
          seen[v] = stamp;
          dist[v] = nd;
          parentArc[v] = a;
          parentNode[v] = u;
          heap.push(v, nd + h(v));
        }
      }
      if (++this.sinceYield >= this.yieldEvery) {
        this.sinceYield = 0;
        yield;
      }
    }
    return null;
  }
}

interface Candidate {
  arcs: number[];
  cost: number;
  /** Index of the spur node where it left its parent route (Lawler). */
  deviation: number;
}

/**
 * Up to `k` cheapest loopless routes from `start` to `goal`, cheapest first.
 * Resumable: pauses every `yieldEvery` expansions.
 */
export function* yenKShortest(
  g: SearchGraph,
  start: number,
  goal: number,
  k: number,
  options: { yieldEvery?: number } = {},
): Generator<void, KShortestResult, void> {
  const searcher = new MaskedAStar(g, goal, options.yieldEvery ?? DEFAULT_YIELD_EVERY);
  const { target, road } = g.out;
  const roadCost = g.roadCost;
  let spurSearches = 0;

  const toRanked = (arcs: number[], cost: number): RankedPath => {
    const path = [start];
    for (const a of arcs) path.push(target[a]);
    return { path, arcs, pathRoads: arcs.map((a) => road[a]), cost };
  };

  if (start === goal) {
    return { paths: g.blocked[start] ? [] : [toRanked([], 0)], spurSearches, expansions: 0 };
  }

  const first = yield* searcher.search(start);
  spurSearches++;
  if (!first) return { paths: [], spurSearches, expansions: searcher.expansions };

  const accepted: Array<RankedPath & { deviation: number }> = [{ ...toRanked(first.arcs, first.cost), deviation: 0 }];
  const candidates = new MinHeap<Candidate>();
  const known = new Set<string>([first.arcs.join(',')]);

  while (accepted.length < k) {
    const prev = accepted[accepted.length - 1] as RankedPath & { deviation: number };
    for (let i = prev.deviation; i < prev.path.length - 1; i++) {
      const spur = prev.path[i] as number;

      // Forbid the next arc of every accepted route that shares this root.
      const banned: number[] = [];
      for (const p of accepted) {
        if (p.arcs.length > i && sameRoot(p.arcs, prev.arcs, i)) {
          const a = p.arcs[i] as number;
          if (!searcher.bannedArc[a]) {
            searcher.bannedArc[a] = 1;
            banned.push(a);
          }
        }
      }
      // Loopless: the spur path may not revisit the root.
      for (let j = 0; j < i; j++) searcher.bannedNode[prev.path[j] as number] = 1;

      const spurPath = yield* searcher.search(spur);
      spurSearches++;

      for (const a of banned) searcher.bannedArc[a] = 0;
      for (let j = 0; j < i; j++) searcher.bannedNode[prev.path[j] as number] = 0;

      if (spurPath) {
        const arcs = prev.arcs.slice(0, i).concat(spurPath.arcs);
        const key = arcs.join(',');
        if (!known.has(key)) {
          known.add(key);
          // Re-sum from the start so equal routes compare equal regardless of how they were assembled.
          let cost = 0;
          for (const a of arcs) cost += roadCost[road[a]];
          candidates.push({ arcs, cost, deviation: i }, cost);
        }
      }
    }

    const next = candidates.pop();
    if (!next) break;
    accepted.push({ ...toRanked(next.arcs, next.cost), deviation: next.deviation });
  }

  return {
    paths: accepted.map(({ deviation: _d, ...p }) => p),
    spurSearches,
    expansions: searcher.expansions,
  };
}

function sameRoot(a: readonly number[], b: readonly number[], length: number): boolean {
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return false;
  return true;
}
