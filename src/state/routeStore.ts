/**
 * Route state: the chosen algorithm, the latest search result and display
 * options. Results are written by the route controller (routeController.ts).
 */

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AlgorithmId, SearchResult } from '../core/graph';
import type { HeuristicId } from '../core/heuristics';
import type { AlternativeRoute, AnalysisResultResponse, CompareEntry, NoRouteInfo } from '../worker/protocol';

export interface ComparisonState {
  status: 'running' | 'done' | 'error';
  /** Latest results (kept on screen while a rerun is in progress). */
  results: CompareEntry[];
  /** Endpoints and map version the results describe. */
  for: { start: string; end: string; version: number } | null;
  error: string | null;
}

export interface AlternativesState {
  status: 'running' | 'done' | 'error';
  /** Cheapest first; routes[0] is the optimal route itself. Kept on screen while a rerun is in progress. */
  routes: AlternativeRoute[];
  /** Endpoints and map version the routes describe. */
  for: { start: string; end: string; version: number } | null;
  spurSearches: number;
  timeMs: number;
  error: string | null;
}

/** Details of the latest result beyond the SearchResult itself. */
export interface RouteMeta {
  legs: number;
  /** On a multi-leg route with no route: the leg that failed (0 = start to the first stop). */
  failedLeg: number | null;
  /** Turn restrictions were in force. */
  turnRestricted: boolean;
  /** D* Lite: the result came from repairing an earlier search rather than a fresh one. */
  reused: boolean | null;
}

/** Why a route was (re)computed. Only some reasons replay the exploration animation. */
export type RouteReason = 'endpoints' | 'algorithm' | 'manual' | 'mapChange';

export interface RouteState {
  algorithm: AlgorithmId;
  /** Heuristic used when the algorithm is A*. */
  heuristic: HeuristicId;
  /** Latest result, or null when start/end are not both set. */
  result: SearchResult | null;
  /** Endpoints and map version the result was computed for. */
  resultFor: { start: string; end: string; waypoints: readonly string[]; version: number; algorithm: AlgorithmId; heuristic: HeuristicId } | null;
  meta: RouteMeta | null;
  /** How the latest result was produced: a full search, or a reachability check that proved there is no route. */
  method: 'search' | 'reachability' | null;
  /** When there is no route: the cut-off region and the barriers around it. */
  noRoute: NoRouteInfo | null;
  /** Latest network health report (regions, isolated intersections), with the map version it describes. */
  network: (Omit<AnalysisResultResponse, 'type' | 'requestId'> & { version: number }) | null;
  status: 'idle' | 'computing' | 'done' | 'error';
  /** A request has been pending for over ~100 ms: fade the old route, show "Recalculating…". */
  slow: boolean;
  error: string | null;
  /**
   * Incremented whenever the exploration wave should (re)play. The canvas
   * compares it to the last value it animated; a new result with the same
   * token is shown instantly, without the wave.
   */
  animationToken: number;

  /** Algorithm comparison (bottom panel). */
  comparison: ComparisonState | null;
  /** Re-run the comparison automatically after each route result. */
  compareAuto: boolean;
  /** Include A* with the Manhattan heuristic in the comparison. */
  compareManhattan: boolean;

  /** Alternative routes (Yen's k-shortest paths). */
  alternatives: AlternativesState | null;
  showAlternatives: boolean;
  /** Routes to find, including the best one (2..5). */
  alternativesK: number;

  // Display options
  showExplored: boolean;
  animate: boolean;
  /** Recompute automatically when the map changes. */
  autoRoute: boolean;

  setAlgorithm(algorithm: AlgorithmId): void;
  setHeuristic(heuristic: HeuristicId): void;
  toggleExplored(): void;
  toggleAnimate(): void;
  toggleAutoRoute(): void;
  replay(): void;
  toggleCompareAuto(): void;
  toggleCompareManhattan(): void;
  toggleAlternatives(): void;
  setAlternativesK(k: number): void;
}

export function createRouteStore(): StoreApi<RouteState> {
  return createStore<RouteState>()((set, get) => ({
    algorithm: 'dijkstra',
    heuristic: 'euclidean',
    result: null,
    resultFor: null,
    meta: null,
    method: null,
    noRoute: null,
    network: null,
    status: 'idle',
    slow: false,
    error: null,
    animationToken: 0,
    comparison: null,
    compareAuto: true,
    compareManhattan: false,
    alternatives: null,
    showAlternatives: false,
    alternativesK: 3,
    showExplored: true,
    animate: true,
    autoRoute: true,

    setAlgorithm: (algorithm) => set({ algorithm }),
    setHeuristic: (heuristic) => set({ heuristic }),
    toggleExplored: () => set({ showExplored: !get().showExplored }),
    toggleAnimate: () => set({ animate: !get().animate }),
    toggleAutoRoute: () => set({ autoRoute: !get().autoRoute }),
    replay: () => set({ animationToken: get().animationToken + 1 }),
    toggleCompareAuto: () => set({ compareAuto: !get().compareAuto }),
    toggleCompareManhattan: () => set({ compareManhattan: !get().compareManhattan }),
    toggleAlternatives: () => set({ showAlternatives: !get().showAlternatives }),
    setAlternativesK: (k) => set({ alternativesK: Math.max(2, Math.min(5, Math.round(k))) }),
  }));
}

export const routeStore = createRouteStore();

export function useRouteStore<T>(selector: (s: RouteState) => T): T {
  return useStore(routeStore, selector);
}
