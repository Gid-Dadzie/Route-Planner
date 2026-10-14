/**
 * Main-thread client for the pathfinding engine.
 *
 * - Keeps the worker's graph in sync: a full `loadGraph` when the graph's
 *   shape changes (roads/intersections added or removed, a road redirected),
 *   otherwise only the deltas since the last sync (closures, traffic, obstacles,
 *   moved intersections, edited distances). Sync happens lazily, right before
 *   each request, so a burst of edits costs one sync.
 * - Numbers requests with increasing ids and delivers only the response to the
 *   latest request of each kind; stale responses are dropped.
 * - Large bursts of deltas (a traffic preset touching every road) go in one
 *   `applyDeltas` message; turn restrictions travel as a single delta holding
 *   the whole (small) list.
 */

import type { AlgorithmId, GraphEdge, GraphNode, SearchResult } from '../core/graph';
import type { HeuristicId } from '../core/heuristics';
import type { TurnRestriction } from '../core/turns';
import { diffDynamic } from './graphDiff';
import type { AlternativesResultResponse, AnalysisResultResponse, CompareEntry, RouteResultResponse, WorkerResponse } from './protocol';
import type { RouteTransport } from './transport';

/** The map state the client needs to sync the worker's graph. */
export interface MapSnapshot {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: ReadonlyMap<string, GraphEdge>;
  turnRestrictions?: ReadonlyMap<string, TurnRestriction>;
}

export interface RouteQuery {
  start: string;
  end: string;
  algorithm: AlgorithmId;
  heuristic: HeuristicId;
  /** Intermediate stops, in order. Omit (or leave empty) for a direct route. */
  waypoints?: string[];
}

/** More deltas than this are sent as one `applyDeltas` message instead of one message each. */
export const DELTA_BATCH_THRESHOLD = 32;

const NO_TURNS: ReadonlyMap<string, TurnRestriction> = new Map();

export interface RouteClientHandlers {
  onRoute(requestId: number, result: SearchResult, response: RouteResultResponse): void;
  onCompare?(requestId: number, results: CompareEntry[]): void;
  onAnalysis?(report: AnalysisResultResponse): void;
  onAlternatives?(requestId: number, response: AlternativesResultResponse): void;
  /** requestId is -1 for errors not tied to a request (invalid graph, worker crash). */
  onError(requestId: number, message: string): void;
}

export interface ClientStats {
  graphLoads: number;
  deltasSent: number;
  staleDropped: number;
}

export class RouteClient {
  private nextId = 1;
  private latestRouteId = 0;
  private latestCompareId = 0;
  private latestAnalyzeId = 0;
  private latestAlternativesId = 0;
  private synced: { nodes: MapSnapshot['nodes']; edges: MapSnapshot['edges']; turns: ReadonlyMap<string, TurnRestriction> } | null = null;
  readonly stats: ClientStats = { graphLoads: 0, deltasSent: 0, staleDropped: 0 };

  constructor(
    private readonly transport: RouteTransport,
    private readonly handlers: RouteClientHandlers,
  ) {
    transport.onMessage((msg) => this.receive(msg));
    transport.onFatalError((message) => handlers.onError(-1, message));
  }

  /** Syncs the graph, sends a findRoute and returns its request id. */
  findRoute(map: MapSnapshot, query: RouteQuery): number {
    this.sync(map);
    const requestId = this.nextId++;
    this.latestRouteId = requestId;
    const { waypoints, ...rest } = query;
    this.transport.post({ type: 'findRoute', requestId, ...rest, ...(waypoints?.length ? { waypoints } : {}) });
    return requestId;
  }

  /** Syncs the graph and asks for up to `k` cheapest loopless routes (the first is the optimal one). */
  findAlternatives(map: MapSnapshot, start: string, end: string, k: number): number {
    this.sync(map);
    const requestId = this.nextId++;
    this.latestAlternativesId = requestId;
    this.transport.post({ type: 'findAlternatives', requestId, start, end, k });
    return requestId;
  }

  /** Makes any in-flight alternatives response stale. */
  cancelAlternatives(): void {
    this.latestAlternativesId = this.nextId++;
  }

  /** Syncs the graph, asks the worker to run every algorithm, returns the request id. */
  compareAll(map: MapSnapshot, start: string, end: string, options: { includeManhattan?: boolean; repeats?: number; waypoints?: string[] } = {}): number {
    this.sync(map);
    const requestId = this.nextId++;
    this.latestCompareId = requestId;
    const { waypoints, ...rest } = options;
    this.transport.post({ type: 'compareAll', requestId, start, end, ...rest, ...(waypoints?.length ? { waypoints } : {}) });
    return requestId;
  }

  /** Syncs the graph and asks for a network health report (regions, isolated intersections). */
  analyze(map: MapSnapshot): number {
    this.sync(map);
    const requestId = this.nextId++;
    this.latestAnalyzeId = requestId;
    this.transport.post({ type: 'analyze', requestId });
    return requestId;
  }

  /** Makes any in-flight route response stale (e.g. the endpoints were cleared). */
  cancelRoute(): void {
    this.latestRouteId = this.nextId++;
  }

  dispose(): void {
    this.transport.terminate();
  }

  /** Brings the worker's graph up to date with `map`. */
  private sync(map: MapSnapshot): void {
    const prev = this.synced;
    const turns = map.turnRestrictions ?? NO_TURNS;
    if (prev && prev.nodes === map.nodes && prev.edges === map.edges && prev.turns === turns) return;

    const deltas = prev ? diffDynamic(prev.nodes, prev.edges, map.nodes, map.edges) : null;
    if (deltas) {
      if (prev && prev.turns !== turns) deltas.push({ op: 'setTurnRestrictions', restrictions: [...turns.values()] });
      if (deltas.length > DELTA_BATCH_THRESHOLD) this.transport.post({ type: 'applyDeltas', deltas });
      else for (const delta of deltas) this.transport.post({ type: 'applyDelta', delta });
      this.stats.deltasSent += deltas.length;
    } else {
      this.transport.post({
        type: 'loadGraph',
        graph: { nodes: [...map.nodes.values()], edges: [...map.edges.values()], ...(turns.size > 0 ? { turnRestrictions: [...turns.values()] } : {}) },
      });
      this.stats.graphLoads++;
    }
    this.synced = { nodes: map.nodes, edges: map.edges, turns };
  }

  private receive(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'routeResult':
        if (msg.requestId !== this.latestRouteId) {
          this.stats.staleDropped++;
          return;
        }
        this.handlers.onRoute(msg.requestId, toSearchResult(msg), msg);
        break;
      case 'compareResult':
        if (msg.requestId !== this.latestCompareId) {
          this.stats.staleDropped++;
          return;
        }
        this.handlers.onCompare?.(msg.requestId, msg.results);
        break;
      case 'analysisResult':
        if (msg.requestId !== this.latestAnalyzeId) {
          this.stats.staleDropped++;
          return;
        }
        this.handlers.onAnalysis?.(msg);
        break;
      case 'alternativesResult':
        if (msg.requestId !== this.latestAlternativesId) {
          this.stats.staleDropped++;
          return;
        }
        this.handlers.onAlternatives?.(msg.requestId, msg);
        break;
      case 'error':
        if (msg.requestId === -1) {
          // The worker's graph is unusable; force a full reload next time.
          this.synced = null;
          this.handlers.onError(-1, msg.message);
        } else if (
          msg.requestId === this.latestRouteId ||
          msg.requestId === this.latestCompareId ||
          msg.requestId === this.latestAnalyzeId ||
          msg.requestId === this.latestAlternativesId
        ) {
          this.handlers.onError(msg.requestId, msg.message);
        } else {
          this.stats.staleDropped++;
        }
        break;
    }
  }
}

function toSearchResult(msg: RouteResultResponse): SearchResult {
  return {
    path: msg.path,
    pathRoads: msg.pathRoads,
    cost: msg.cost,
    distance: msg.distance,
    found: msg.found,
    exploredInOrder: msg.explored,
    ...(msg.exploredSides ? { exploredSides: msg.exploredSides } : {}),
    nodesExplored: msg.nodesExplored,
    timeMs: msg.timeMs,
  };
}
