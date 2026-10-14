/**
 * The pathfinding engine that runs inside the worker. Pure TypeScript with
 * injected I/O (`post`) and scheduling (`yieldToEventLoop`), so it can be
 * tested in Node without a real Worker.
 *
 * Cooperative cancellation
 * ------------------------
 * A worker processes one message at a time and cannot see new messages while
 * a synchronous loop runs. So searches run in time slices: the search
 * generator pauses every `checkEvery` node expansions (default 500); at each
 * pause, if the slice (`sliceMs`, default 8 ms) is used up, the engine awaits
 * `yieldToEventLoop()`. Queued messages are handled during that pause, and
 * when the search resumes it checks:
 *
 * - superseded: a newer request of the same kind arrived -> abandon (no response);
 * - dirty: the graph changed (delta or reload) -> restart on the new graph.
 *
 * Restarting matters for correctness: a paused search holds distances computed
 * on the old graph, so finishing it after a mutation could return a route that
 * uses a road that has since closed.
 *
 * Phase 10 additions
 * ------------------
 * - Waypoints: a route start -> w1 -> ... -> end is one search per leg; the
 *   legs are concatenated. Each leg gets its own reachability check.
 * - Turn restrictions: when any are in force, each leg runs on a line graph
 *   (core/turns.ts). Its topology is cached per (start, goal); closures and
 *   traffic are copied in before every use.
 * - D* Lite: `findRoute` keeps one persistent instance per destination (a
 *   few, least-recently-used). Deltas are forwarded to them as they arrive,
 *   so the next request only repairs what changed. A "dirty" restart simply
 *   continues the same instance. The comparison runs D* Lite from scratch so
 *   its timing is comparable with the others.
 * - Alternatives: Yen's k-shortest paths, time-sliced like every other search.
 */

import { ALGORITHMS, getAlgorithm } from '../core/algorithms';
import { DStarLite } from '../core/dstarLite';
import {
  compileGraph,
  setNodeBlocked,
  setNodePosition,
  setRoadDistance,
  setRoadClosed,
  setRoadTraffic,
  type AlgorithmId,
  type SearchGraph,
} from '../core/graph';
import type { HeuristicId } from '../core/heuristics';
import { yenKShortest } from '../core/kShortest';
import { resolveNode, toSearchResult, type IndexedSearchResult, type SearchFactory } from '../core/search';
import { analyzeNetwork, explainNoRoute, reachableFrom, type CutOff, type Reach } from '../core/traversal';
import {
  buildTurnGraph,
  compileTurnRestrictions,
  refreshTurnGraph,
  turnPathToBase,
  turnResultToBase,
  type BannedTurns,
  type TurnGraph,
  type TurnRestriction,
} from '../core/turns';
import type {
  CompareAllRequest,
  CompareEntry,
  FindAlternativesRequest,
  FindRouteRequest,
  GraphDelta,
  NoRouteInfo,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

export interface EngineOptions {
  /** Node expansions between checkpoints. */
  checkEvery?: number;
  /** Compute time before yielding to the event loop to receive messages. */
  sliceMs?: number;
  yieldToEventLoop?: () => Promise<void>;
  now?: () => number;
}

export interface EngineStats {
  started: number;
  completed: number;
  /** Abandoned because a newer request superseded them. */
  cancelled: number;
  /** Restarted because the graph changed mid-search. */
  restarted: number;
  /** Total checkpoints at which the engine yielded to the event loop. */
  yields: number;
  /** Route requests answered by the reachability check alone (no route, search skipped). */
  reachabilityShortcuts: number;
  /** D* Lite legs answered by repairing an existing search. */
  incrementalReuses: number;
}

interface Job {
  dirty: boolean;
}

type SliceOutcome<T> = { status: 'done'; value: T; computeMs: number } | { status: 'stale' } | { status: 'dirty' };

/** How to run each leg of a route. */
interface Variant {
  algorithm: AlgorithmId;
  heuristic: HeuristicId;
  search: SearchFactory;
  /** Use the persistent D* Lite instances (findRoute only). */
  incremental: boolean;
  /** Prove "no route" with a BFS before searching (findRoute only). */
  reachabilityFirst: boolean;
}

type RouteOutcome =
  | { status: 'stale' }
  | { status: 'dirty' }
  /** The reachability check proved leg `leg` has no route. */
  | { status: 'unreachable'; leg: number; start: number; goal: number; reach: Reach; computeMs: number }
  /** All legs searched. If `result.found` is false, leg `failedLeg` failed and `result` describes that leg only. */
  | { status: 'done'; result: IndexedSearchResult; computeMs: number; reused: boolean; failedLeg: number | null };

/** Persistent D* Lite searches and cached line graphs kept per engine. */
const MAX_INCREMENTAL = 6;
const MAX_TURN_GRAPHS = 8;
/** A delta batch touching more than this share of roads restarts D* Lite instead of repairing it. */
const INCREMENTAL_RESET_FRACTION = 0.05;

/**
 * Fastest available "let the event loop run" primitive. MessageChannel posts a
 * macrotask without setTimeout's ~4 ms clamping; setTimeout is the fallback.
 */
export function createEventLoopYield(): () => Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    const channel = new MessageChannel();
    const waiting: Array<() => void> = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    // In Node, don't let the channel keep the process alive (no-op in browsers).
    (channel.port1 as { unref?: () => void }).unref?.();
    (channel.port2 as { unref?: () => void }).unref?.();
    return () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      });
  }
  return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class PathEngine {
  private graph: SearchGraph | null = null;
  private restrictions: TurnRestriction[] = [];
  /** Compiled lazily for the current graph and restrictions. */
  private banned: BannedTurns | null = null;
  /** Line graphs by "start:goal", least recently used first. */
  private readonly turnGraphs = new Map<string, TurnGraph>();
  /** Persistent D* Lite searches by goal index, least recently used first. */
  private readonly incremental = new Map<number, DStarLite>();
  private latestRouteId = -Infinity;
  private latestCompareId = -Infinity;
  private latestAlternativesId = -Infinity;
  private readonly running = new Set<Job>();
  private readonly checkEvery: number;
  private readonly sliceMs: number;
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly now: () => number;

  readonly stats: EngineStats = { started: 0, completed: 0, cancelled: 0, restarted: 0, yields: 0, reachabilityShortcuts: 0, incrementalReuses: 0 };

  constructor(
    private readonly post: (msg: WorkerResponse) => void,
    options: EngineOptions = {},
  ) {
    this.checkEvery = options.checkEvery ?? 500;
    this.sliceMs = options.sliceMs ?? 8;
    this.yieldToEventLoop = options.yieldToEventLoop ?? createEventLoopYield();
    this.now = options.now ?? (() => performance.now());
  }

  /** True while any search is in progress (possibly paused). */
  get busy(): boolean {
    return this.running.size > 0;
  }

  handle(msg: WorkerRequest): void {
    switch (msg.type) {
      case 'loadGraph':
        try {
          this.graph = compileGraph(msg.graph);
        } catch (err) {
          this.graph = null;
          this.post({ type: 'error', requestId: -1, message: errorMessage(err) });
        }
        this.restrictions = msg.graph.turnRestrictions ?? [];
        this.resetDerived();
        this.markRunningDirty();
        break;
      case 'applyDelta':
        if (this.graph && this.applyDelta(this.graph, msg.delta)) this.markRunningDirty();
        break;
      case 'applyDeltas': {
        // A bulk change (e.g. a traffic preset) invalidates most of any D* Lite
        // search; repairing it costs more than starting afresh, so drop them.
        if (this.graph && msg.deltas.length > Math.max(64, this.graph.roadCount * INCREMENTAL_RESET_FRACTION)) this.incremental.clear();
        let changed = false;
        if (this.graph) for (const delta of msg.deltas) changed = this.applyDelta(this.graph, delta) || changed;
        if (changed) this.markRunningDirty();
        break;
      }
      case 'findRoute':
        this.latestRouteId = Math.max(this.latestRouteId, msg.requestId);
        void this.runRoute(msg);
        break;
      case 'analyze':
        this.runAnalysis(msg.requestId);
        break;
      case 'compareAll':
        this.latestCompareId = Math.max(this.latestCompareId, msg.requestId);
        void this.runCompare(msg);
        break;
      case 'findAlternatives':
        this.latestAlternativesId = Math.max(this.latestAlternativesId, msg.requestId);
        void this.runAlternatives(msg);
        break;
    }
  }

  /** Drops everything derived from the compiled graph (it was replaced). */
  private resetDerived(): void {
    this.banned = null;
    this.turnGraphs.clear();
    this.incremental.clear();
  }

  private applyDelta(g: SearchGraph, d: GraphDelta): boolean {
    switch (d.op) {
      case 'closeEdge':
        return setRoadClosed(g, d.edgeId, true) && this.roadChanged(g, d.edgeId);
      case 'openEdge':
        return setRoadClosed(g, d.edgeId, false) && this.roadChanged(g, d.edgeId);
      case 'setTraffic':
        return setRoadTraffic(g, d.edgeId, d.level) && this.roadChanged(g, d.edgeId);
      case 'setDistance':
        return setRoadDistance(g, d.edgeId, d.distance) && this.roadChanged(g, d.edgeId);
      case 'blockNode':
        return setNodeBlocked(g, d.nodeId, true) && this.nodeChanged(g, d.nodeId);
      case 'unblockNode':
        return setNodeBlocked(g, d.nodeId, false) && this.nodeChanged(g, d.nodeId);
      case 'moveNode':
        if (!setNodePosition(g, d.nodeId, d.x, d.y)) return false;
        // Positions feed D* Lite's queue keys (the heuristic); start those searches afresh.
        this.incremental.clear();
        return true;
      case 'setTurnRestrictions':
        this.restrictions = d.restrictions;
        this.banned = null;
        this.turnGraphs.clear();
        return true;
    }
  }

  /** Tells the persistent D* Lite searches that a road's cost changed. */
  private roadChanged(g: SearchGraph, roadId: string): true {
    const r = g.roadIndex.get(roadId) as number;
    for (const d of this.incremental.values()) d.roadChanged(r);
    return true;
  }

  private nodeChanged(g: SearchGraph, nodeId: string): true {
    const v = g.nodeIndex.get(nodeId) as number;
    for (const d of this.incremental.values()) d.nodeChanged(v);
    return true;
  }

  private markRunningDirty(): void {
    for (const job of this.running) job.dirty = true;
  }

  // ---- Route requests ---------------------------------------------------------

  private async runRoute(req: FindRouteRequest): Promise<void> {
    const isStale = () => req.requestId < this.latestRouteId;
    const heuristic: HeuristicId = req.heuristic ?? 'euclidean';
    const info = getAlgorithm(req.algorithm);
    if (!info?.search) {
      this.post({ type: 'error', requestId: req.requestId, message: `Algorithm "${req.algorithm}" is not available.` });
      return;
    }
    const variant: Variant = {
      algorithm: req.algorithm,
      heuristic,
      search: info.search,
      incremental: req.algorithm === 'dstarlite',
      reachabilityFirst: true,
    };

    const job: Job = { dirty: false };
    this.running.add(job);
    this.stats.started++;
    try {
      for (;;) {
        const g = this.requireGraph(req.requestId);
        if (!g) return;
        job.dirty = false;

        const stops = this.resolveStops(g, req.requestId, [req.start, ...(req.waypoints ?? []), req.end]);
        if (!stops) return;
        const legs = stops.length - 1;
        const turnRestricted = this.turnsActive(g);

        const outcome = await this.searchRoute(g, stops, variant, job, isStale);
        if (outcome.status === 'stale') return;
        if (outcome.status === 'dirty') continue;

        this.stats.completed++;
        const common = { type: 'routeResult' as const, requestId: req.requestId, algorithm: req.algorithm, heuristic, legs, turnRestricted };

        if (outcome.status === 'unreachable') {
          // A heap-free BFS (stopping at the goal) proved "no route" without the weighted search.
          const { reach, start, goal, leg } = outcome;
          const cut = explainNoRoute(g, start, goal, reach) as CutOff;
          this.stats.reachabilityShortcuts++;
          this.post({
            ...common,
            found: false,
            path: [],
            pathRoads: [],
            cost: Infinity,
            distance: 0,
            explored: idsOf(g, reach.order),
            nodesExplored: reach.count,
            timeMs: outcome.computeMs,
            method: 'reachability',
            noRoute: {
              reason: cut.reason,
              side: cut.side,
              region: idsOf(g, cut.region),
              closedRoads: cut.barrierRoads.filter((r) => g.roadClosed[r]).map((r) => g.roadIds[r] as string),
              oneWayRoads: cut.barrierRoads.filter((r) => !g.roadClosed[r]).map((r) => g.roadIds[r] as string),
              blockedNodes: cut.barrierNodes.map((i) => g.nodeIds[i] as string),
              startSideCount: cut.startSideCount,
            },
            ...(legs > 1 ? { failedLeg: leg } : {}),
          });
          return;
        }

        const r = toSearchResult(g, outcome.result, outcome.computeMs);
        // Reachable but not found: only banned turns can do that.
        const noRoute: NoRouteInfo | undefined = r.found
          ? undefined
          : { reason: 'turn-restrictions', side: 'end', region: [], closedRoads: [], oneWayRoads: [], blockedNodes: [], startSideCount: r.nodesExplored };
        this.post({
          ...common,
          found: r.found,
          path: r.path,
          pathRoads: r.pathRoads,
          cost: r.cost,
          distance: r.distance,
          explored: r.exploredInOrder,
          ...(r.exploredSides ? { exploredSides: r.exploredSides } : {}),
          nodesExplored: r.nodesExplored,
          timeMs: r.timeMs,
          method: 'search',
          ...(noRoute ? { noRoute } : {}),
          ...(legs > 1 && outcome.failedLeg !== null ? { failedLeg: outcome.failedLeg } : {}),
          ...(variant.incremental ? { reused: outcome.reused } : {}),
        });
        return;
      }
    } finally {
      this.running.delete(job);
    }
  }

  /**
   * Searches every leg of `stops` in order and concatenates the results.
   * Explored nodes of all legs are listed one leg after another.
   */
  private async searchRoute(g: SearchGraph, stops: readonly number[], variant: Variant, job: Job, isStale: () => boolean): Promise<RouteOutcome> {
    const path: number[] = [stops[0] as number];
    const pathRoads: number[] = [];
    const explored: Int32Array[] = [];
    const sides: Array<Uint8Array | null> = [];
    let cost = 0;
    let computeMs = 0;
    let reused = true;

    for (let leg = 0; leg < stops.length - 1; leg++) {
      const s = stops[leg] as number;
      const t = stops[leg + 1] as number;

      if (variant.reachabilityFirst) {
        const t0 = this.now();
        const reach = reachableFrom(g, s, t);
        computeMs += this.now() - t0;
        if (!reach.inSet[t]) return { status: 'unreachable', leg, start: s, goal: t, reach, computeMs };
      }

      const outcome = await this.searchLeg(g, s, t, variant, job, isStale);
      if (outcome.status !== 'done') return outcome;
      computeMs += outcome.computeMs;
      const r = outcome.value.result;
      reused &&= outcome.value.reused;
      if (!r.found) return { status: 'done', result: r, computeMs, reused, failedLeg: leg };

      for (let i = 1; i < r.path.length; i++) path.push(r.path[i] as number);
      pathRoads.push(...r.pathRoads);
      cost += r.cost;
      explored.push(r.explored);
      sides.push(r.exploredSides ?? null);
    }

    const merged = concatInt32(explored);
    const anySides = sides.some((x) => x !== null);
    const result: IndexedSearchResult = {
      found: true,
      cost,
      path,
      pathRoads,
      explored: merged,
      ...(anySides ? { exploredSides: concatSides(sides, explored) } : {}),
    };
    return { status: 'done', result, computeMs, reused, failedLeg: null };
  }

  /** One leg: on the line graph when turns are restricted, else on the graph itself (or the persistent D* Lite). */
  private async searchLeg(
    g: SearchGraph,
    s: number,
    t: number,
    variant: Variant,
    job: Job,
    isStale: () => boolean,
  ): Promise<SliceOutcome<{ result: IndexedSearchResult; reused: boolean }>> {
    const options = { yieldEvery: this.checkEvery, heuristic: variant.heuristic };

    if (this.turnsActive(g)) {
      const tg = this.turnGraphFor(g, s, t);
      refreshTurnGraph(tg);
      const outcome = await this.drive(variant.search(tg.graph, tg.source, tg.sink, options), job, isStale);
      if (outcome.status !== 'done') return outcome;
      return { ...outcome, value: { result: turnResultToBase(tg, outcome.value), reused: false } };
    }

    if (variant.incremental) {
      const d = this.incrementalFor(g, t, s);
      const reused = d.runs > 0;
      const outcome = await this.drive(d.run(s, this.checkEvery), job, isStale);
      if (outcome.status !== 'done') return outcome;
      if (reused) this.stats.incrementalReuses++;
      return { ...outcome, value: { result: outcome.value, reused } };
    }

    const outcome = await this.drive(variant.search(g, s, t, options), job, isStale);
    if (outcome.status !== 'done') return outcome;
    return { ...outcome, value: { result: outcome.value, reused: false } };
  }

  /**
   * Runs every available algorithm on the same endpoints (and waypoints), A*
   * with the admissible Euclidean heuristic (plus Manhattan if requested).
   * Unlike findRoute there is no reachability shortcut and D* Lite starts from
   * scratch: the point is to compare the searches themselves. Each variant gets
   * one untimed warm-up run (JIT), then `repeats` timed runs; the median time
   * is reported, since a single sub-millisecond run is mostly timer noise.
   */
  private async runCompare(req: CompareAllRequest): Promise<void> {
    const isStale = () => req.requestId < this.latestCompareId;
    const repeats = Math.max(1, Math.min(25, req.repeats ?? 5));
    const variants: Variant[] = [];
    const add = (algorithm: AlgorithmId, heuristic: HeuristicId, search: SearchFactory) =>
      variants.push({ algorithm, heuristic, search, incremental: false, reachabilityFirst: false });
    for (const info of ALGORITHMS) {
      if (!info.search) continue;
      add(info.id, 'euclidean', info.search);
      if (info.id === 'astar' && req.includeManhattan) add('astar', 'manhattan', info.search);
    }

    const job: Job = { dirty: false };
    this.running.add(job);
    this.stats.started++;
    try {
      restart: for (;;) {
        const g = this.requireGraph(req.requestId);
        if (!g) return;
        job.dirty = false;
        const stops = this.resolveStops(g, req.requestId, [req.start, ...(req.waypoints ?? []), req.end]);
        if (!stops) return;

        const results: CompareEntry[] = [];
        for (const v of variants) {
          const times: number[] = [];
          let first: IndexedSearchResult | null = null;
          for (let i = 0; i <= repeats; i++) {
            const outcome = await this.searchRoute(g, stops, v, job, isStale);
            if (outcome.status === 'stale') return;
            if (outcome.status === 'dirty') continue restart;
            if (outcome.status === 'unreachable') throw new Error('unreachable outcome without a reachability check');
            if (i === 0) first = outcome.result; // warm-up: result kept, time discarded
            else times.push(outcome.computeMs);
          }
          const r = toSearchResult(g, first as IndexedSearchResult, median(times));
          results.push({
            algorithm: v.algorithm,
            heuristic: v.algorithm === 'astar' ? v.heuristic : null,
            found: r.found,
            cost: r.cost,
            distance: r.distance,
            intersections: r.path.length,
            nodesExplored: r.nodesExplored,
            timeMs: r.timeMs,
          });
        }

        this.stats.completed++;
        this.post({ type: 'compareResult', requestId: req.requestId, results });
        return;
      }
    } finally {
      this.running.delete(job);
    }
  }

  /** Yen's k-shortest routes between two intersections (respecting turn restrictions). */
  private async runAlternatives(req: FindAlternativesRequest): Promise<void> {
    const isStale = () => req.requestId < this.latestAlternativesId;
    const k = Math.max(1, Math.min(8, Math.floor(req.k)));
    const job: Job = { dirty: false };
    this.running.add(job);
    this.stats.started++;
    try {
      for (;;) {
        const g = this.requireGraph(req.requestId);
        if (!g) return;
        job.dirty = false;
        const stops = this.resolveStops(g, req.requestId, [req.start, req.end]);
        if (!stops) return;
        const [s, t] = stops as [number, number];

        let tg: TurnGraph | null = null;
        let run;
        if (this.turnsActive(g)) {
          tg = this.turnGraphFor(g, s, t);
          refreshTurnGraph(tg);
          // Loopless on the road-to-road graph still allows revisiting an intersection
          // (e.g. a U-turn and back). Ask for extra candidates and drop those below.
          run = yenKShortest(tg.graph, tg.source, tg.sink, Math.min(3 * k, 16), { yieldEvery: this.checkEvery });
        } else {
          run = yenKShortest(g, s, t, k, { yieldEvery: this.checkEvery });
        }
        const outcome = await this.drive(run, job, isStale);
        if (outcome.status === 'stale') return;
        if (outcome.status === 'dirty') continue;

        const turnGraph = tg;
        const bases = outcome.value.paths.map((p) => ({
          cost: p.cost,
          ...(turnGraph ? turnPathToBase(turnGraph, p.path) : { path: p.path, pathRoads: p.pathRoads }),
        }));
        // The best route is kept even if banned turns force it to revisit an intersection.
        const kept = bases.filter((b, i) => i === 0 || new Set(b.path).size === b.path.length).slice(0, k);
        const routes = kept.map((base) => {
          let distance = 0;
          for (const r of base.pathRoads) distance += g.roadDistance[r];
          return {
            path: idsOf(g, base.path),
            pathRoads: base.pathRoads.map((r) => g.roadIds[r] as string),
            cost: base.cost,
            distance,
          };
        });
        this.stats.completed++;
        this.post({ type: 'alternativesResult', requestId: req.requestId, routes, spurSearches: outcome.value.spurSearches, timeMs: outcome.computeMs });
        return;
      }
    } finally {
      this.running.delete(job);
    }
  }

  /**
   * Network validation (regions, isolated intersections). A single O(V + E)
   * DFS pass, run synchronously: ~1 ms for 10,000 nodes.
   */
  private runAnalysis(requestId: number): void {
    const g = this.requireGraph(requestId);
    if (!g) return;
    const report = analyzeNetwork(g);
    this.post({
      type: 'analysisResult',
      requestId,
      regions: report.regions,
      largestRegion: report.largestRegion,
      isolated: idsOf(g, report.isolated),
      blocked: report.blocked,
      usable: g.nodeCount - report.blocked,
    });
  }

  // ---- Helpers ------------------------------------------------------------------

  private requireGraph(requestId: number): SearchGraph | null {
    if (!this.graph) this.post({ type: 'error', requestId, message: 'No graph loaded.' });
    return this.graph;
  }

  /** Resolves stop ids to indices, posting an error and returning null on an unknown id. */
  private resolveStops(g: SearchGraph, requestId: number, ids: readonly string[]): number[] | null {
    try {
      return ids.map((id) => resolveNode(g, id));
    } catch (err) {
      this.post({ type: 'error', requestId, message: errorMessage(err) });
      return null;
    }
  }

  /** True if at least one turn restriction applies to the current graph. */
  private turnsActive(g: SearchGraph): boolean {
    if (this.restrictions.length === 0) return false;
    this.banned ??= compileTurnRestrictions(g, this.restrictions);
    return this.banned.count > 0;
  }

  private turnGraphFor(g: SearchGraph, s: number, t: number): TurnGraph {
    const key = `${s}:${t}`;
    let tg = this.turnGraphs.get(key);
    if (tg) {
      this.turnGraphs.delete(key); // re-insert as most recently used
    } else {
      tg = buildTurnGraph(g, this.banned as BannedTurns, s, t);
      if (this.turnGraphs.size >= MAX_TURN_GRAPHS) this.turnGraphs.delete(this.turnGraphs.keys().next().value as string);
    }
    this.turnGraphs.set(key, tg);
    return tg;
  }

  private incrementalFor(g: SearchGraph, goal: number, start: number): DStarLite {
    let d = this.incremental.get(goal);
    if (d) {
      this.incremental.delete(goal);
    } else {
      d = new DStarLite(g, goal, start);
      if (this.incremental.size >= MAX_INCREMENTAL) this.incremental.delete(this.incremental.keys().next().value as number);
    }
    this.incremental.set(goal, d);
    return d;
  }

  /**
   * Advances a search in time slices, yielding to the event loop between
   * slices. Returns 'stale' or 'dirty' if, after a pause, the request was
   * superseded or the graph changed.
   */
  private async drive<T>(run: Generator<void, T, void>, job: Job, isStale: () => boolean): Promise<SliceOutcome<T>> {
    let computeMs = 0;
    let sliceStart = this.now();
    for (;;) {
      const step = run.next(); // advances up to `checkEvery` expansions
      if (step.done) {
        computeMs += this.now() - sliceStart;
        return { status: 'done', value: step.value, computeMs };
      }
      // Checkpoint: yield once the slice is used up.
      if (this.now() - sliceStart < this.sliceMs) continue;
      computeMs += this.now() - sliceStart;
      this.stats.yields++;
      await this.yieldToEventLoop();
      if (isStale()) {
        run.return(undefined as never);
        this.stats.cancelled++;
        return { status: 'stale' };
      }
      if (job.dirty) {
        run.return(undefined as never);
        this.stats.restarted++;
        return { status: 'dirty' };
      }
      sliceStart = this.now();
    }
  }
}

function idsOf(g: SearchGraph, indices: ArrayLike<number>): string[] {
  const ids = new Array<string>(indices.length);
  for (let i = 0; i < indices.length; i++) ids[i] = g.nodeIds[indices[i] as number] as string;
  return ids;
}

function concatInt32(parts: readonly Int32Array[]): Int32Array {
  if (parts.length === 1) return parts[0] as Int32Array;
  const out = new Int32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Concatenates per-leg side markers; legs without them count as forward (0). */
function concatSides(sides: ReadonlyArray<Uint8Array | null>, explored: readonly Int32Array[]): Uint8Array {
  const out = new Uint8Array(explored.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  sides.forEach((s, i) => {
    if (s) out.set(s, offset);
    offset += (explored[i] as Int32Array).length;
  });
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
