/**
 * Message protocol between the main thread and the pathfinding worker.
 *
 * The main thread sends the full graph once (`loadGraph`) and again only after
 * structural edits. Closures, traffic changes and obstacles travel as small
 * `applyDelta` messages. Messages are processed in order, so a `findRoute`
 * always sees every delta sent before it.
 */

import type { AlgorithmId, SerializedGraph, TrafficLevel } from '../core/graph';
import type { HeuristicId } from '../core/heuristics';
import type { TurnRestriction } from '../core/turns';

export type GraphDelta =
  | { op: 'closeEdge' | 'openEdge'; edgeId: string }
  | { op: 'setTraffic'; edgeId: string; level: TrafficLevel }
  | { op: 'blockNode' | 'unblockNode'; nodeId: string }
  /** Geometry edits that keep the graph's shape: sent instead of a full reload when a node is dragged. */
  | { op: 'moveNode'; nodeId: string; x: number; y: number }
  | { op: 'setDistance'; edgeId: string; distance: number }
  /** Replaces the whole list of banned turns (it is small, so no finer-grained delta is needed). */
  | { op: 'setTurnRestrictions'; restrictions: TurnRestriction[] };

// ---- Main -> Worker ---------------------------------------------------------

export interface LoadGraphRequest {
  type: 'loadGraph';
  graph: SerializedGraph & { turnRestrictions?: TurnRestriction[] };
}

export interface ApplyDeltaRequest {
  type: 'applyDelta';
  delta: GraphDelta;
}

/** Many deltas in one message (e.g. a time-of-day traffic preset touching every road). */
export interface ApplyDeltasRequest {
  type: 'applyDeltas';
  deltas: GraphDelta[];
}

export interface FindRouteRequest {
  type: 'findRoute';
  /** Strictly increasing. A newer findRoute cancels any older one still running. */
  requestId: number;
  start: string;
  end: string;
  algorithm: AlgorithmId;
  /** Used by A* only. Default 'euclidean'. */
  heuristic?: HeuristicId;
  /** Intermediate stops, visited in order: the route is start -> waypoints -> end, one search per leg. */
  waypoints?: string[];
}

export interface CompareAllRequest {
  type: 'compareAll';
  requestId: number;
  start: string;
  end: string;
  /** Also run A* with the (inadmissible) Manhattan heuristic, to show its trade-off. */
  includeManhattan?: boolean;
  /** Timed runs per algorithm after one warm-up run; the median is reported. Default 5. */
  repeats?: number;
  waypoints?: string[];
}

/** Up to `k` cheapest loopless routes (Yen's algorithm), for showing alternatives. */
export interface FindAlternativesRequest {
  type: 'findAlternatives';
  requestId: number;
  start: string;
  end: string;
  k: number;
}

export type WorkerRequest =
  | LoadGraphRequest
  | ApplyDeltaRequest
  | ApplyDeltasRequest
  | FindRouteRequest
  | CompareAllRequest
  | AnalyzeRequest
  | FindAlternativesRequest;

// ---- Worker -> Main ---------------------------------------------------------

export interface RouteResultResponse {
  type: 'routeResult';
  requestId: number;
  algorithm: AlgorithmId;
  heuristic: HeuristicId;
  found: boolean;
  /** Node ids, start to end. */
  path: string[];
  /** Road ids along the path. */
  pathRoads: string[];
  cost: number;
  distance: number;
  /**
   * Node ids in the order they were settled. When no route exists this is the
   * reachability BFS order: everything reachable from the start.
   */
  explored: string[];
  /** Bidirectional search and D* Lite: 0 = forward side, 1 = backward side, aligned with `explored`. */
  exploredSides?: Uint8Array;
  nodesExplored: number;
  /** Pure computation time, excluding pauses spent yielding to the event loop. */
  timeMs: number;
  /**
   * 'reachability': a BFS proved no route exists, so the weighted search was skipped.
   * 'search': the requested algorithm ran.
   */
  method: 'search' | 'reachability';
  /** Present when found is false: what is cut off and why. */
  noRoute?: NoRouteInfo;
  /** Number of legs (1 + waypoints). */
  legs: number;
  /** When found is false on a multi-leg route: the leg that failed (0 = start to the first stop). */
  failedLeg?: number;
  /** Turn restrictions were in force (the search ran on the line graph). */
  turnRestricted: boolean;
  /** D* Lite only: true if every leg reused an earlier search (a repair, not a fresh search). */
  reused?: boolean;
}

export interface NoRouteInfo {
  /**
   * 'turn-restrictions': the destination is reachable, but only through banned turns.
   * In that case the region and barrier lists are empty.
   */
  reason: 'blocked-start' | 'blocked-end' | 'unreachable' | 'turn-restrictions';
  /** Which side is highlighted: the smaller of "reachable from the start" and "can reach the end". */
  side: 'start' | 'end';
  /** Intersections of the highlighted region. */
  region: string[];
  /** Closed roads on the region's boundary. */
  closedRoads: string[];
  /** Open one-way roads that only cross the boundary in the wrong direction. */
  oneWayRoads: string[];
  /** Blocked intersections on the boundary (or the blocked endpoint itself). */
  blockedNodes: string[];
  /** Number of intersections reachable from the start. */
  startSideCount: number;
}

export interface AnalyzeRequest {
  type: 'analyze';
  requestId: number;
}

export interface AnalysisResultResponse {
  type: 'analysisResult';
  requestId: number;
  /** Connected regions among usable intersections (open roads, direction ignored). */
  regions: number;
  largestRegion: number;
  /** Usable intersections with no open road to another usable one. */
  isolated: string[];
  blocked: number;
  /** Usable (non-blocked) intersections. */
  usable: number;
}

export interface CompareEntry {
  algorithm: AlgorithmId;
  heuristic: HeuristicId | null;
  found: boolean;
  cost: number;
  distance: number;
  /** Intersections on the route (0 when not found). */
  intersections: number;
  nodesExplored: number;
  /** Median of the timed runs. */
  timeMs: number;
}

export interface CompareResultResponse {
  type: 'compareResult';
  requestId: number;
  results: CompareEntry[];
}

export interface AlternativeRoute {
  path: string[];
  pathRoads: string[];
  cost: number;
  distance: number;
}

export interface AlternativesResultResponse {
  type: 'alternativesResult';
  requestId: number;
  /** Cheapest first; the first is the optimal route. Empty when there is no route. */
  routes: AlternativeRoute[];
  spurSearches: number;
  timeMs: number;
}

export interface ErrorResponse {
  type: 'error';
  /** The failed request, or -1 for errors not tied to a request (e.g. an invalid graph). */
  requestId: number;
  message: string;
}

export type WorkerResponse = RouteResultResponse | CompareResultResponse | AnalysisResultResponse | AlternativesResultResponse | ErrorResponse;
