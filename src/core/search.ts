/**
 * Infrastructure shared by all search algorithms.
 *
 * Each algorithm is written as a generator over node indices (a `SearchRun`)
 * that `yield`s every `yieldEvery` node expansions. That gives two ways to
 * drive the same code:
 *
 * - `runSearchSync` runs it to completion (tests, simple callers).
 * - The worker (Phase 6) runs it in time slices. At each pause it returns to
 *   the event loop so incoming messages are processed, then either resumes or
 *   abandons the search with `run.return()` if a newer request has arrived.
 *   A single synchronous loop could not be cancelled this way, because a
 *   worker cannot receive messages while it is busy.
 *
 * Results are produced in index space (`IndexedSearchResult`) and converted to
 * string ids once at the end by `toSearchResult`.
 */

import type { SearchGraph, SearchResult } from './graph';
import type { HeuristicId } from './heuristics';

/** Default number of node expansions between cooperative pauses. */
export const DEFAULT_YIELD_EVERY = 500;

/** Search result in index space, before mapping to ids. */
export interface IndexedSearchResult {
  found: boolean;
  cost: number;
  /** Node indices from start to goal inclusive. */
  path: number[];
  /** Road index used for each step (length = path.length - 1). */
  pathRoads: number[];
  /** Settled node indices, in settle order. */
  explored: Int32Array;
  /** Bidirectional search and D* Lite: 0 = settled searching forward from the start, 1 = backward from the goal, aligned with `explored`. */
  exploredSides?: Uint8Array;
}

/**
 * A resumable search. Yields `void` at each cooperative pause and returns the
 * final result when finished.
 */
export type SearchRun = Generator<void, IndexedSearchResult, void>;

export interface SearchRunOptions {
  /** Node expansions between pauses. Default DEFAULT_YIELD_EVERY. */
  yieldEvery?: number;
  /** A* heuristic (ignored by other algorithms). Default euclidean. */
  heuristic?: HeuristicId;
}

/** Maps a node id to its index, throwing a readable error for unknown ids. */
export function resolveNode(g: SearchGraph, id: string): number {
  const i = g.nodeIndex.get(id);
  if (i === undefined) throw new Error(`Unknown intersection "${id}"`);
  return i;
}

export function notFound(explored: Int32Array, exploredCount: number): IndexedSearchResult {
  return { found: false, cost: Infinity, path: [], pathRoads: [], explored: explored.subarray(0, exploredCount) };
}

/**
 * Follows `parent` / `parentRoad` links back from `goal` to the start
 * (whose parent is -1) and returns the path in start -> goal order.
 */
export function reconstructPath(
  parent: Int32Array,
  parentRoad: Int32Array,
  goal: number,
): { path: number[]; pathRoads: number[] } {
  const path: number[] = [];
  const pathRoads: number[] = [];
  for (let v = goal; v !== -1; v = parent[v]) {
    path.push(v);
    if (parent[v] !== -1) pathRoads.push(parentRoad[v]);
  }
  path.reverse();
  pathRoads.reverse();
  return { path, pathRoads };
}

/** Converts an index-space result into the public, id-based SearchResult. */
export function toSearchResult(g: SearchGraph, r: IndexedSearchResult, timeMs: number): SearchResult {
  let distance = 0;
  for (const road of r.pathRoads) distance += g.roadDistance[road];

  const exploredInOrder = new Array<string>(r.explored.length);
  for (let i = 0; i < r.explored.length; i++) exploredInOrder[i] = g.nodeIds[r.explored[i]] as string;

  return {
    path: r.path.map((i) => g.nodeIds[i] as string),
    pathRoads: r.pathRoads.map((i) => g.roadIds[i] as string),
    cost: r.cost,
    distance,
    found: r.found,
    exploredInOrder,
    ...(r.exploredSides ? { exploredSides: r.exploredSides } : {}),
    nodesExplored: r.explored.length,
    timeMs,
  };
}

/** Creates a search for the given node indices. */
export type SearchFactory = (g: SearchGraph, start: number, goal: number, options?: SearchRunOptions) => SearchRun;

/** Resolves ids, runs a search to completion and returns the timed, id-based result. */
export function runSearchSync(
  factory: SearchFactory,
  g: SearchGraph,
  startId: string,
  endId: string,
  options?: SearchRunOptions,
): SearchResult {
  const start = resolveNode(g, startId);
  const goal = resolveNode(g, endId);

  const t0 = performance.now();
  const run = factory(g, start, goal, options);
  let step = run.next();
  while (!step.done) step = run.next();
  const timeMs = performance.now() - t0;

  return toSearchResult(g, step.value, timeMs);
}
