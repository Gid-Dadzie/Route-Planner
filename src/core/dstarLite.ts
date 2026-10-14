/**
 * D* Lite (Koenig & Likhachev, 2002): incremental shortest paths.
 *
 * Dijkstra, A* and bidirectional search start from scratch on every request.
 * D* Lite keeps its search between requests and, when a road closes or its
 * traffic changes, repairs only the part of the solution the change affects.
 *
 * It searches backward, from the goal toward the start, keeping two values per
 * node:
 *   g(s)   the cost-to-goal found by the last expansion of s;
 *   rhs(s) a one-step lookahead: min over arcs s -> s' of c(s, s') + g(s').
 * A node is *consistent* when g = rhs. A change in arc costs only makes the
 * arc's source inconsistent; those nodes go into a priority queue keyed by
 *   [min(g, rhs) + h(start, s) + km, min(g, rhs)]
 * and are expanded until the start is consistent and nothing in the queue can
 * still improve it. With an unchanged map a request does no work at all.
 *
 * Moving the start keeps the search too: instead of re-keying the whole queue,
 * the heuristic drift is accumulated in `km` (the "key modifier"), which works
 * because the Euclidean heuristic obeys the triangle inequality. Moving the
 * goal needs a new instance.
 *
 * Arc cost follows the other algorithms: Infinity for closed roads and arcs
 * into blocked intersections; a blocked start means no route.
 *
 * The queue is a binary heap of (node, k1, k2) with lazy deletion: each node
 * remembers its current key, and popped entries that no longer match it, or
 * whose node has left the queue, are discarded.
 */

import type { SearchGraph, SearchResult } from './graph';
import {
  DEFAULT_YIELD_EVERY,
  notFound,
  runSearchSync,
  type IndexedSearchResult,
  type SearchRun,
  type SearchRunOptions,
} from './search';

/** Min-heap ordered by (k1, k2) lexicographically. */
class KeyHeap {
  private items: number[] = [];
  private k1: number[] = [];
  private k2: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, a: number, b: number): void {
    const { items, k1, k2 } = this;
    let i = items.length;
    items.push(item);
    k1.push(a);
    k2.push(b);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a, b, k1[p] as number, k2[p] as number)) break;
      items[i] = items[p] as number;
      k1[i] = k1[p] as number;
      k2[i] = k2[p] as number;
      i = p;
    }
    items[i] = item;
    k1[i] = a;
    k2[i] = b;
  }

  topItem(): number {
    return this.items[0] as number;
  }
  topK1(): number {
    return this.k1[0] as number;
  }
  topK2(): number {
    return this.k2[0] as number;
  }

  pop(): void {
    const { items, k1, k2 } = this;
    const lastItem = items.pop() as number;
    const lastA = k1.pop() as number;
    const lastB = k2.pop() as number;
    const n = items.length;
    if (n === 0) return;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && less(k1[r] as number, k2[r] as number, k1[l] as number, k2[l] as number) ? r : l;
      if (!less(k1[c] as number, k2[c] as number, lastA, lastB)) break;
      items[i] = items[c] as number;
      k1[i] = k1[c] as number;
      k2[i] = k2[c] as number;
      i = c;
    }
    items[i] = lastItem;
    k1[i] = lastA;
    k2[i] = lastB;
  }

  /** Rebuilds the heap from the entries `keep` accepts (drops stale entries). */
  compact(keep: (item: number, a: number, b: number) => boolean): void {
    const { items, k1, k2 } = this;
    this.items = [];
    this.k1 = [];
    this.k2 = [];
    for (let i = 0; i < items.length; i++) {
      if (keep(items[i] as number, k1[i] as number, k2[i] as number)) this.push(items[i] as number, k1[i] as number, k2[i] as number);
    }
  }
}

function less(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 < b1 || (a1 === b1 && a2 < b2);
}

/** A persistent D* Lite search toward one goal. */
export class DStarLite {
  private readonly g: Float64Array;
  private readonly rhs: Float64Array;
  private readonly inQueue: Uint8Array;
  private readonly keyA: Float64Array;
  private readonly keyB: Float64Array;
  private readonly heap = new KeyHeap();
  private km = 0;
  private start: number;
  /** Total expansions over the instance's life (for stats). */
  expansions = 0;
  /** Requests answered so far; 0 means the next run builds the search from scratch. */
  runs = 0;

  constructor(
    readonly graph: SearchGraph,
    readonly goal: number,
    start: number,
  ) {
    const n = graph.nodeCount;
    this.g = new Float64Array(n).fill(Infinity);
    this.rhs = new Float64Array(n).fill(Infinity);
    this.inQueue = new Uint8Array(n);
    this.keyA = new Float64Array(n);
    this.keyB = new Float64Array(n);
    this.start = start;
    this.rhs[goal] = 0;
    this.insert(goal);
  }

  /** The costs of road `r`'s arcs changed (closed, reopened, traffic or distance). */
  roadChanged(r: number): void {
    this.updateVertex(this.graph.roadFrom[r]);
    this.updateVertex(this.graph.roadTo[r]);
  }

  /** Intersection `v` was blocked or unblocked: every arc into it changed, and so did its own lookahead. */
  nodeChanged(v: number): void {
    const { offsets, target } = this.graph.in;
    for (let a = offsets[v], end = offsets[v + 1]; a < end; a++) this.updateVertex(target[a]);
    this.updateVertex(v);
  }

  /**
   * Brings the search up to date for `start` and returns the route. Pauses
   * every `yieldEvery` expansions; abandoning the generator at a pause leaves
   * the instance valid, and the next run carries on from there.
   * `explored` lists the nodes expanded by this run only.
   */
  *run(start: number, yieldEvery = DEFAULT_YIELD_EVERY): SearchRun {
    const gr = this.graph;
    if (start !== this.start) {
      this.km += this.h(this.start, start);
      this.start = start;
    }
    this.runs++;

    const explored: number[] = [];
    const { g, rhs } = this;
    const { offsets: inOff, target: inTarget } = gr.in;
    let sinceYield = 0;

    if (!gr.blocked[start]) {
      for (;;) {
        this.dropStale();
        const empty = this.heap.size === 0;
        const startKeyA = Math.min(g[start], rhs[start]) + this.km; // h(start, start) = 0
        const startKeyB = Math.min(g[start], rhs[start]);
        const topBelowStart = !empty && less(this.heap.topK1(), this.heap.topK2(), startKeyA, startKeyB);
        if (!topBelowStart && rhs[start] === g[start]) break;
        if (empty) break; // unreachable in theory: inconsistent nodes are always queued

        const u = this.heap.topItem();
        const oldA = this.heap.topK1();
        const oldB = this.heap.topK2();
        this.heap.pop();
        this.inQueue[u] = 0;

        const newA = this.keyFirst(u);
        const newB = Math.min(g[u], rhs[u]);
        if (less(oldA, oldB, newA, newB)) {
          // The key was computed for an earlier start: re-queue with the current one.
          this.insert(u);
        } else if (g[u] > rhs[u]) {
          // Overconsistent: a cheaper way to the goal was found. Settle it.
          g[u] = rhs[u];
          explored.push(u);
          for (let a = inOff[u], end = inOff[u + 1]; a < end; a++) this.updateVertex(inTarget[a]);
        } else {
          // Underconsistent: the old way got dearer. Reset and re-derive.
          g[u] = Infinity;
          explored.push(u);
          for (let a = inOff[u], end = inOff[u + 1]; a < end; a++) this.updateVertex(inTarget[a]);
          this.updateVertex(u);
        }

        if (++sinceYield >= yieldEvery) {
          sinceYield = 0;
          yield;
        }
      }
    }

    this.expansions += explored.length;
    const exploredArr = Int32Array.from(explored);
    return this.extractPath(start, exploredArr);
  }

  // ---- Internals -------------------------------------------------------------

  private h(a: number, b: number): number {
    const dx = this.graph.x[a] - this.graph.x[b];
    const dy = this.graph.y[a] - this.graph.y[b];
    return Math.sqrt(dx * dx + dy * dy);
  }

  private keyFirst(s: number): number {
    return Math.min(this.g[s], this.rhs[s]) + this.h(this.start, s) + this.km;
  }

  private insert(s: number): void {
    const a = this.keyFirst(s);
    const b = Math.min(this.g[s], this.rhs[s]);
    this.inQueue[s] = 1;
    this.keyA[s] = a;
    this.keyB[s] = b;
    this.heap.push(s, a, b);
  }

  private isLive(s: number, a: number, b: number): boolean {
    return this.inQueue[s] === 1 && this.keyA[s] === a && this.keyB[s] === b;
  }

  /** Discards stale entries at the top; compacts when they pile up. */
  private dropStale(): void {
    const heap = this.heap;
    while (heap.size > 0 && !this.isLive(heap.topItem(), heap.topK1(), heap.topK2())) heap.pop();
    if (heap.size > 4 * this.graph.nodeCount + 64) {
      // Duplicates of the same live key are kept once.
      const kept = new Uint8Array(this.graph.nodeCount);
      heap.compact((s, a, b) => {
        if (kept[s] || !this.isLive(s, a, b)) return false;
        kept[s] = 1;
        return true;
      });
    }
  }

  private arcCost(r: number, v: number): number {
    const gr = this.graph;
    return gr.roadClosed[r] || gr.blocked[v] ? Infinity : gr.roadCost[r];
  }

  /** Recomputes rhs(u) and (re)queues u if it is inconsistent. */
  private updateVertex(u: number): void {
    const { offsets, target, road } = this.graph.out;
    if (u !== this.goal) {
      // A blocked intersection is on no route (a blocked start is handled in run), so it is never expanded.
      let best = Infinity;
      for (let a = offsets[u], end = this.graph.blocked[u] ? offsets[u] : offsets[u + 1]; a < end; a++) {
        const v = target[a];
        const c = this.arcCost(road[a], v);
        if (c === Infinity) continue;
        const total = c + this.g[v];
        if (total < best) best = total;
      }
      this.rhs[u] = best;
    }
    if (this.g[u] !== this.rhs[u]) this.insert(u);
    else this.inQueue[u] = 0;
  }

  /**
   * Walks from the start, always taking the arc minimising c(s, s') + g(s').
   * The cost is summed forward along the path, in the same order as the other
   * algorithms, so equal routes report bit-identical costs.
   */
  private extractPath(start: number, explored: Int32Array): IndexedSearchResult {
    const gr = this.graph;
    if (gr.blocked[start] || this.rhs[start] === Infinity || this.g[start] === Infinity) return notFound(explored, explored.length);
    const { offsets, target, road } = gr.out;
    const path = [start];
    const pathRoads: number[] = [];
    let cost = 0;
    let u = start;
    for (let steps = 0; u !== this.goal; steps++) {
      if (steps > gr.nodeCount) return notFound(explored, explored.length); // defensive: never loops on a consistent search
      let best = Infinity;
      let bestArc = -1;
      for (let a = offsets[u], end = offsets[u + 1]; a < end; a++) {
        const c = this.arcCost(road[a], target[a]);
        if (c === Infinity) continue;
        const total = c + this.g[target[a]];
        if (total < best) {
          best = total;
          bestArc = a;
        }
      }
      if (bestArc < 0) return notFound(explored, explored.length);
      cost += gr.roadCost[road[bestArc]];
      u = target[bestArc];
      path.push(u);
      pathRoads.push(road[bestArc]);
    }
    // Backward search: every expansion grows from the destination (side 1).
    return { found: true, cost, path, pathRoads, explored, exploredSides: new Uint8Array(explored.length).fill(1) };
  }
}

/**
 * From-scratch D* Lite, with the same shape as the other searches. The worker
 * keeps persistent instances for incremental repair; this factory is used by
 * the comparison and the tests.
 */
export function* dstarLiteSearch(g: SearchGraph, start: number, goal: number, options: SearchRunOptions = {}): SearchRun {
  const d = new DStarLite(g, goal, start);
  return yield* d.run(start, options.yieldEvery ?? DEFAULT_YIELD_EVERY);
}

/** Runs D* Lite from scratch between two intersection ids. */
export function dstarLite(g: SearchGraph, startId: string, endId: string, options?: SearchRunOptions): SearchResult {
  return runSearchSync(dstarLiteSearch, g, startId, endId, options);
}
