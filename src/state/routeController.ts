/**
 * Keeps the route in sync with the map, computing it in the pathfinding worker.
 *
 * - Endpoint, algorithm and heuristic changes send a request immediately.
 * - Map edits are debounced: a request is sent `debounceMs` (75) after the
 *   last edit, but at least every `maxWaitMs` (250) during a continuous burst
 *   such as dragging a node, so the route keeps up.
 * - Edits that cannot affect the current route (closures, worse traffic or
 *   obstacles off the route) are skipped entirely: the route stays optimal.
 * - While a request is pending the old route stays on screen. If it takes
 *   longer than `slowMs` (100), `slow` is set: the canvas fades the old route
 *   and a "Recalculating…" indicator appears.
 * - Only the response to the latest request is applied (the client drops stale ones).
 * - In auto mode, the algorithm comparison re-runs `compareDelayMs` after the
 *   route settles.
 * - Waypoints are part of the query (one search per leg). Turn restrictions
 *   are part of the map: changing them always recomputes.
 * - With alternatives switched on (and no waypoints), Yen's k-shortest routes
 *   are fetched `compareDelayMs` after the route settles.
 */

import type { StoreApi } from 'zustand/vanilla';
import { getAlgorithm } from '../core/algorithms';
import type { AlgorithmId } from '../core/graph';
import type { HeuristicId } from '../core/heuristics';
import { RouteClient } from '../worker/client';
import { diffDynamic, routeUnaffected } from '../worker/graphDiff';
import type { CompareEntry } from '../worker/protocol';
import type { RouteTransport } from '../worker/transport';
import type { MapState } from './mapStore';
import type { RouteReason, RouteState } from './routeStore';

export interface RouteControllerOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  slowMs?: number;
  /** Delay before re-running the network health analysis after map edits. */
  analysisDelayMs?: number;
  /** Delay before an automatic comparison after a route result (lets bursts settle). */
  compareDelayMs?: number;
  /** Timed runs per algorithm in a comparison (median reported). */
  compareRepeats?: number;
  /** Delay before fetching alternative routes after a route result. Default: compareDelayMs. */
  alternativesDelayMs?: number;
  /** Also receives compareAll results (tests; the panel reads routeStore.comparison). */
  onCompare?(requestId: number, results: CompareEntry[]): void;
}

export interface RouteController {
  /** Requests a route now (cancelling any pending debounce). */
  compute(reason: RouteReason): void;
  /**
   * Runs every algorithm on the current endpoints; results land in
   * routeStore.comparison. Returns the request id, or null without endpoints.
   */
  compareAll(): number | null;
  /** Fetches alternative routes now (if switched on and applicable). */
  findAlternatives(): number | null;
  /** Resolves once no request is pending or scheduled (for tests). */
  whenIdle(): Promise<void>;
  readonly client: RouteClient;
  dispose(): void;
}

/** Timed runs per algorithm in a comparison; the median is shown. */
export const DEFAULT_COMPARE_REPEATS = 5;

/** Reasons that replay the exploration wave (map edits update the route silently). */
const ANIMATED_REASONS: ReadonlySet<RouteReason> = new Set(['endpoints', 'algorithm', 'manual']);

interface Pending {
  id: number;
  reason: RouteReason;
  nodes: MapState['nodes'];
  edges: MapState['edges'];
  turns: MapState['turnRestrictions'];
  version: number;
  start: string;
  end: string;
  waypoints: readonly string[];
  algorithm: AlgorithmId;
  heuristic: HeuristicId;
}

export function createRouteController(
  map: StoreApi<MapState>,
  route: StoreApi<RouteState>,
  transport: RouteTransport,
  options: RouteControllerOptions = {},
): RouteController {
  const debounceMs = options.debounceMs ?? 75;
  const maxWaitMs = options.maxWaitMs ?? 250;
  const slowMs = options.slowMs ?? 100;
  const analysisDelayMs = options.analysisDelayMs ?? 150;
  const compareDelayMs = options.compareDelayMs ?? 300;
  const compareRepeats = options.compareRepeats ?? DEFAULT_COMPARE_REPEATS;
  const alternativesDelayMs = options.alternativesDelayMs ?? compareDelayMs;

  /** The in-flight alternatives request and what it describes. */
  let alternativesPending: { id: number; start: string; end: string; version: number } | null = null;
  let alternativesTimer: ReturnType<typeof setTimeout> | null = null;

  /** The in-flight comparison and what it describes. */
  let comparePending: { id: number; start: string; end: string; version: number } | null = null;
  let compareTimer: ReturnType<typeof setTimeout> | null = null;

  let pending: Pending | null = null;
  /** The map snapshot the displayed result is valid for (used to decide whether edits can be skipped). */
  let resultMaps: { nodes: MapState['nodes']; edges: MapState['edges']; turns: MapState['turnRestrictions'] } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let analysisTimer: ReturnType<typeof setTimeout> | null = null;
  /** Map version the in-flight analysis describes. */
  let analysisVersion = -1;
  let idleWaiters: Array<() => void> = [];

  const isIdle = () => pending === null && debounceTimer === null;
  const notifyIdle = () => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const clearSchedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    debounceTimer = maxWaitTimer = null;
  };
  const clearSlow = () => {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = null;
  };

  const client = new RouteClient(transport, {
    onRoute: (requestId, result, response) => {
      if (!pending || pending.id !== requestId) return;
      const p = pending;
      pending = null;
      clearSlow();
      resultMaps = { nodes: p.nodes, edges: p.edges, turns: p.turns };
      const { animationToken } = route.getState();
      route.setState({
        result,
        method: response.method,
        noRoute: response.noRoute ?? null,
        resultFor: { start: p.start, end: p.end, waypoints: p.waypoints, version: p.version, algorithm: p.algorithm, heuristic: p.heuristic },
        meta: {
          legs: response.legs,
          failedLeg: response.failedLeg ?? null,
          turnRestricted: response.turnRestricted,
          reused: response.reused ?? null,
        },
        // More edits may already be queued behind this result.
        status: debounceTimer ? 'computing' : 'done',
        slow: false,
        error: null,
        animationToken: ANIMATED_REASONS.has(p.reason) ? animationToken + 1 : animationToken,
      });
      notifyIdle();
      if (route.getState().compareAuto) scheduleCompare();
      scheduleAlternatives();
    },
    onAlternatives: (requestId, response) => {
      if (!alternativesPending || alternativesPending.id !== requestId) return;
      const { start, end, version } = alternativesPending;
      alternativesPending = null;
      route.setState({
        alternatives: { status: 'done', routes: response.routes, for: { start, end, version }, spurSearches: response.spurSearches, timeMs: response.timeMs, error: null },
      });
    },
    onCompare: (requestId, results) => {
      if (!comparePending || comparePending.id !== requestId) return;
      const { start, end, version } = comparePending;
      comparePending = null;
      route.setState({ comparison: { status: 'done', results, for: { start, end, version }, error: null } });
      options.onCompare?.(requestId, results);
    },
    onAnalysis: (report) => {
      const { type: _type, requestId: _id, ...rest } = report;
      route.setState({ network: { ...rest, version: analysisVersion } });
    },
    onError: (requestId, message) => {
      if (alternativesPending && alternativesPending.id === requestId) {
        alternativesPending = null;
        const prev = route.getState().alternatives;
        route.setState({ alternatives: { status: 'error', routes: prev?.routes ?? [], for: prev?.for ?? null, spurSearches: 0, timeMs: 0, error: message } });
        return;
      }
      if (comparePending && comparePending.id === requestId) {
        comparePending = null;
        const prev = route.getState().comparison;
        route.setState({ comparison: { status: 'error', results: prev?.results ?? [], for: prev?.for ?? null, error: message } });
        return;
      }
      if (requestId !== -1 && pending?.id !== requestId) return;
      pending = null;
      clearSlow();
      resultMaps = null;
      route.setState({ result: null, resultFor: null, meta: null, method: null, noRoute: null, status: 'error', error: message, slow: false });
      notifyIdle();
    },
  });

  const compute = (reason: RouteReason): void => {
    clearSchedule();
    const s = map.getState();
    const { algorithm, heuristic } = route.getState();

    if (!s.start || !s.end) {
      client.cancelRoute();
      pending = null;
      resultMaps = null;
      clearSlow();
      cancelCompare();
      cancelAlternatives();
      route.setState({ comparison: null, alternatives: null });
      route.setState({ result: null, resultFor: null, meta: null, method: null, noRoute: null, status: 'idle', error: null, slow: false });
      notifyIdle();
      return;
    }

    const info = getAlgorithm(algorithm);
    if (!info.search) {
      client.cancelRoute();
      pending = null;
      clearSlow();
      route.setState({ result: null, resultFor: null, meta: null, method: null, noRoute: null, status: 'error', error: `${info.label} is not implemented yet.`, slow: false });
      notifyIdle();
      return;
    }

    const waypoints = s.waypoints;
    const id = client.findRoute(s, { start: s.start, end: s.end, algorithm, heuristic, ...(waypoints.length ? { waypoints: [...waypoints] } : {}) });
    pending = { id, reason, nodes: s.nodes, edges: s.edges, turns: s.turnRestrictions, version: s.version, start: s.start, end: s.end, waypoints, algorithm, heuristic };
    route.setState({ status: 'computing' });
    if (!slowTimer) {
      slowTimer = setTimeout(() => {
        slowTimer = null;
        if (pending) route.setState({ slow: true });
      }, slowMs);
    }
  };

  const scheduleMapChange = (): void => {
    route.setState({ status: 'computing' });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => compute('mapChange'), debounceMs);
    if (!maxWaitTimer) maxWaitTimer = setTimeout(() => compute('mapChange'), maxWaitMs);
  };

  /** True if the edits since the displayed result cannot change the optimal route. */
  const canSkip = (s: MapState): boolean => {
    const r = route.getState();
    if (pending || debounceTimer || !r.result || !resultMaps) return false;
    // Without a route the cut-off highlight may still change, and the reachability
    // check that answers it is cheap: always recompute.
    if (!r.result.found) return false;
    if (r.resultFor?.start !== s.start || r.resultFor?.end !== s.end || r.resultFor.waypoints !== s.waypoints) return false;
    if (resultMaps.turns !== s.turnRestrictions) return false;
    const deltas = diffDynamic(resultMaps.nodes, resultMaps.edges, s.nodes, s.edges);
    return deltas !== null && routeUnaffected(deltas, r.result, resultMaps.edges);
  };

  /** Runs the comparison now on the current map and endpoints. */
  const runCompare = (): number | null => {
    if (compareTimer) clearTimeout(compareTimer);
    compareTimer = null;
    const s = map.getState();
    if (!s.start || !s.end) return null;
    const id = client.compareAll(s, s.start, s.end, {
      includeManhattan: route.getState().compareManhattan,
      repeats: compareRepeats,
      ...(s.waypoints.length ? { waypoints: [...s.waypoints] } : {}),
    });
    comparePending = { id, start: s.start, end: s.end, version: s.version };
    const prev = route.getState().comparison;
    route.setState({ comparison: { status: 'running', results: prev?.results ?? [], for: prev?.for ?? null, error: null } });
    return id;
  };

  /**
   * Auto mode: compare shortly after the route settles. Waiting keeps the
   * comparison (5 timed runs per algorithm) from competing with route
   * requests in the worker during bursts of edits.
   */
  function scheduleCompare(): void {
    if (compareTimer) clearTimeout(compareTimer);
    compareTimer = setTimeout(() => {
      compareTimer = null;
      // Still editing? Wait for the next route result instead.
      if (pending || debounceTimer) return;
      runCompare();
    }, compareDelayMs);
  }

  function cancelCompare(): void {
    if (compareTimer) clearTimeout(compareTimer);
    compareTimer = null;
    comparePending = null;
  }

  /** Alternatives apply to direct routes only (not with waypoints). */
  const alternativesApply = (s: MapState): s is MapState & { start: string; end: string } =>
    route.getState().showAlternatives && s.start !== null && s.end !== null && s.waypoints.length === 0;

  /** Fetches alternatives now, or clears them when they don't apply. */
  const runAlternatives = (): number | null => {
    if (alternativesTimer) clearTimeout(alternativesTimer);
    alternativesTimer = null;
    const s = map.getState();
    if (!alternativesApply(s)) {
      cancelAlternatives();
      if (route.getState().alternatives) route.setState({ alternatives: null });
      return null;
    }
    const id = client.findAlternatives(s, s.start, s.end, route.getState().alternativesK);
    alternativesPending = { id, start: s.start, end: s.end, version: s.version };
    const prev = route.getState().alternatives;
    route.setState({
      alternatives: { status: 'running', routes: prev?.routes ?? [], for: prev?.for ?? null, spurSearches: prev?.spurSearches ?? 0, timeMs: prev?.timeMs ?? 0, error: null },
    });
    return id;
  };

  /** After a route result: fetch alternatives once edits settle (they cost up to one search per route node). */
  function scheduleAlternatives(): void {
    if (alternativesTimer) clearTimeout(alternativesTimer);
    if (!alternativesApply(map.getState())) {
      runAlternatives(); // clears them
      return;
    }
    alternativesTimer = setTimeout(() => {
      alternativesTimer = null;
      if (pending || debounceTimer) return; // the next route result reschedules
      runAlternatives();
    }, alternativesDelayMs);
  }

  function cancelAlternatives(): void {
    if (alternativesTimer) clearTimeout(alternativesTimer);
    alternativesTimer = null;
    alternativesPending = null;
    client.cancelAlternatives();
  }

  /** Re-runs the network health analysis once map edits settle. */
  const scheduleAnalysis = (): void => {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = setTimeout(() => {
      analysisTimer = null;
      const s = map.getState();
      analysisVersion = s.version;
      client.analyze(s);
    }, analysisDelayMs);
  };
  scheduleAnalysis();

  const unsubMap = map.subscribe((s, prev) => {
    if (s.version !== prev.version) scheduleAnalysis();
    if (s.start !== prev.start || s.end !== prev.end || s.waypoints !== prev.waypoints) {
      compute('endpoints');
    } else if (s.version !== prev.version && route.getState().autoRoute) {
      if (canSkip(s)) {
        // Still optimal: just mark the result as current for this map version.
        resultMaps = { nodes: s.nodes, edges: s.edges, turns: s.turnRestrictions };
        const r = route.getState();
        if (r.resultFor) route.setState({ resultFor: { ...r.resultFor, version: s.version } });
        // The route is unchanged, but other algorithms' exploration may differ, and so may the alternatives.
        if (r.compareAuto) scheduleCompare();
        scheduleAlternatives();
      } else {
        scheduleMapChange();
      }
    }
  });

  const unsubRoute = route.subscribe((r, prev) => {
    if (r.algorithm !== prev.algorithm || (r.heuristic !== prev.heuristic && r.algorithm === 'astar')) compute('algorithm');
    else if (r.autoRoute && !prev.autoRoute) compute('mapChange'); // catch up on edits made while off
    if (r.compareManhattan !== prev.compareManhattan && r.comparison) runCompare();
    if (r.compareAuto && !prev.compareAuto) runCompare();
    if (r.showAlternatives !== prev.showAlternatives || (r.showAlternatives && r.alternativesK !== prev.alternativesK)) runAlternatives();
  });

  return {
    compute,
    compareAll: runCompare,
    findAlternatives: runAlternatives,
    whenIdle: () => (isIdle() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
    client,
    dispose: () => {
      clearSchedule();
      if (analysisTimer) clearTimeout(analysisTimer);
      cancelCompare();
      cancelAlternatives();
      clearSlow();
      unsubMap();
      unsubRoute();
      client.dispose();
    },
  };
}
