/**
 * Map editor state (Zustand).
 *
 * The network lives in two id-keyed Maps that are replaced (copy-on-write) on
 * every mutation, so subscribers can detect changes by identity.
 *
 * `version` increments on every map mutation. `structureVersion` increments
 * only when the graph's shape or geometry changes (nodes/roads added, removed
 * or moved, distances edited, direction changed). Closures, traffic and
 * obstacles do not bump it: in Phase 6 those become small deltas sent to the
 * worker instead of a full graph reload.
 *
 * Route stops (start, end, waypoints) are not map changes and bump neither
 * counter. Turn restrictions are: they change which routes are legal.
 *
 * The store is created by a factory so tests can make isolated instances;
 * the app uses the `mapStore` singleton through the `useMapStore` hook.
 */

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  defaultRoadDistance,
  euclidean,
  isTrafficLevel,
  MIN_ROAD_DISTANCE,
  minAllowedDistance,
  type GraphEdge,
  type GraphNode,
  type RoadNetwork,
  type TrafficLevel,
} from '../core/graph';
import { turnKey, type TurnRestriction } from '../core/turns';
import { demoMap } from '../utils/mapGenerator';
import { presetTraffic, type TrafficPresetId } from '../utils/trafficPresets';

export type Tool =
  | 'select'
  | 'addNode'
  | 'addRoad'
  | 'oneWay'
  | 'traffic'
  | 'obstacle'
  | 'closeRoad'
  | 'move'
  | 'delete'
  | 'setStart'
  | 'setEnd'
  | 'waypoint';

/** Most intermediate stops a route can have. */
export const MAX_WAYPOINTS = 8;

/** Everything a saved map holds besides the network itself. */
export interface MapExtras {
  start?: string | null;
  end?: string | null;
  waypoints?: readonly string[];
  turnRestrictions?: readonly TurnRestriction[];
}

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string };

export interface MapState {
  // --- Network ---
  nodes: ReadonlyMap<string, GraphNode>;
  edges: ReadonlyMap<string, GraphEdge>;
  start: string | null;
  end: string | null;
  /** Intermediate stops, visited in order between start and end. */
  waypoints: readonly string[];
  /** Banned turns, keyed by turnKey(). */
  turnRestrictions: ReadonlyMap<string, TurnRestriction>;

  // --- Editor UI ---
  tool: Tool;
  trafficBrush: TrafficLevel;
  selection: Selection | null;
  /** First node clicked while drawing a road; the next node click completes it. */
  pendingRoadFrom: string | null;
  showLabels: boolean;

  // --- Change tracking ---
  version: number;
  structureVersion: number;
  /** Incremented to ask the canvas to fit the whole map in view. */
  fitRequest: number;

  // --- Id counters ---
  nextNodeNum: number;
  nextRoadNum: number;

  // --- Editor actions ---
  setTool(tool: Tool): void;
  setTrafficBrush(level: TrafficLevel): void;
  select(selection: Selection | null): void;
  setPendingRoadFrom(nodeId: string | null): void;
  toggleLabels(): void;
  requestFit(): void;

  // --- Map mutations ---
  /** Adds an intersection and returns its id. */
  addNode(x: number, y: number): string;
  /**
   * Adds a two-way road and returns its id. If a road already joins the two
   * intersections (either direction) returns that road's id instead.
   * Returns null for invalid endpoints (missing or identical).
   */
  addRoad(from: string, to: string): string | null;
  moveNode(id: string, x: number, y: number): void;
  deleteNode(id: string): void;
  deleteEdge(id: string): void;
  deleteSelection(): void;
  setNodeLabel(id: string, label: string): void;
  setBlocked(nodeId: string, blocked: boolean): void;
  toggleBlocked(nodeId: string): void;
  setTraffic(edgeId: string, level: TrafficLevel): void;
  setClosed(edgeId: string, closed: boolean): void;
  toggleClosed(edgeId: string): void;
  /** Reopens roads and removes obstacles in a single change (e.g. clearing a cut-off's barriers). */
  reopen(roadIds: readonly string[], nodeIds: readonly string[]): void;
  setOneWay(edgeId: string, oneWay: boolean): void;
  /** Swaps a road's from/to (flips a one-way road's direction). */
  reverseEdge(edgeId: string): void;
  /** Cycles two-way -> one-way -> one-way reversed -> two-way. */
  cycleDirection(edgeId: string): void;
  /**
   * Sets a road's distance, raised to the straight-line length if lower so the
   * A* heuristic stays admissible. Returns the distance actually applied, or
   * null if the input was rejected (non-finite or <= 0) or the road is unknown.
   */
  setEdgeDistance(edgeId: string, distance: number): number | null;
  setStart(nodeId: string | null): void;
  setEnd(nodeId: string | null): void;
  /** Adds the intersection as the last waypoint, or removes it if it already is one. */
  toggleWaypoint(nodeId: string): void;
  /** Moves the waypoint at `index` one place earlier (-1) or later (+1). */
  moveWaypoint(index: number, offset: -1 | 1): void;
  removeWaypoint(index: number): void;
  clearWaypoints(): void;
  /** Bans the turn, or allows it again if it is already banned. */
  toggleTurnRestriction(turn: TurnRestriction): void;
  /** Removes every turn restriction (at one intersection, if given). */
  clearTurnRestrictions(viaNodeId?: string): void;
  /** Sets every road's traffic from a time-of-day preset. Returns how many roads changed. */
  applyTrafficPreset(preset: TrafficPresetId): number;
  /** Replaces the whole map (assumed valid) and fits it in view. */
  loadNetwork(network: RoadNetwork, extras?: MapExtras): void;
  clearMap(): void;
}

/** Smallest unused counter above every existing `<prefix><number>` id. */
function nextCounter(ids: Iterable<string>, prefix: string): number {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = -1;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Finds a road joining a and b in either direction. */
function findRoadBetween(edges: ReadonlyMap<string, GraphEdge>, a: string, b: string): GraphEdge | undefined {
  for (const e of edges.values()) {
    if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) return e;
  }
  return undefined;
}

export function createMapStore(initial: RoadNetwork = { nodes: [], edges: [] }, endpoints: MapExtras = {}): StoreApi<MapState> {
  return createStore<MapState>()((set, get) => {
    /** Applies a network patch and bumps the version counters. */
    const commit = (patch: Partial<MapState>, structural: boolean): void => {
      const s = get();
      set({
        ...patch,
        version: s.version + 1,
        structureVersion: structural ? s.structureVersion + 1 : s.structureVersion,
      });
    };

    /** Replaces one edge (copy-on-write). */
    const updateEdge = (id: string, fn: (e: GraphEdge) => GraphEdge, structural: boolean): void => {
      const e = get().edges.get(id);
      if (!e) return;
      const edges = new Map(get().edges);
      edges.set(id, fn(e));
      commit({ edges }, structural);
    };

    /** Replaces one node (copy-on-write). */
    const updateNode = (id: string, fn: (n: GraphNode) => GraphNode, structural: boolean): void => {
      const n = get().nodes.get(id);
      if (!n) return;
      const nodes = new Map(get().nodes);
      nodes.set(id, fn(n));
      commit({ nodes }, structural);
    };

    /** Clears every reference to a removed node or edge from editor and route state. */
    const forget = (s: MapState, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): Partial<MapState> => {
      const sel = s.selection;
      const selGone = sel !== null && (sel.kind === 'node' ? nodeIds.has(sel.id) : edgeIds.has(sel.id));
      const waypoints = s.waypoints.filter((id) => !nodeIds.has(id));
      let turnRestrictions: Map<string, TurnRestriction> | null = null;
      for (const [key, t] of s.turnRestrictions) {
        if (!nodeIds.has(t.via) && !edgeIds.has(t.fromRoad) && !edgeIds.has(t.toRoad)) continue;
        turnRestrictions ??= new Map(s.turnRestrictions);
        turnRestrictions.delete(key);
      }
      return {
        start: s.start !== null && nodeIds.has(s.start) ? null : s.start,
        end: s.end !== null && nodeIds.has(s.end) ? null : s.end,
        selection: selGone ? null : sel,
        pendingRoadFrom: s.pendingRoadFrom !== null && nodeIds.has(s.pendingRoadFrom) ? null : s.pendingRoadFrom,
        ...(waypoints.length !== s.waypoints.length ? { waypoints } : {}),
        ...(turnRestrictions ? { turnRestrictions } : {}),
      };
    };

    const networkState = (network: RoadNetwork, ends: MapExtras) => {
      const nodes = new Map(network.nodes.map((n) => [n.id, n]));
      const edges = new Map(network.edges.map((e) => [e.id, e]));
      const valid = (id: string | null | undefined): string | null => (id != null && nodes.has(id) ? id : null);
      const turns = (ends.turnRestrictions ?? []).filter((t) => nodes.has(t.via) && edges.has(t.fromRoad) && edges.has(t.toRoad));
      return {
        nodes,
        edges,
        start: valid(ends.start),
        end: valid(ends.end),
        waypoints: (ends.waypoints ?? []).filter((id) => nodes.has(id)).slice(0, MAX_WAYPOINTS),
        turnRestrictions: new Map(turns.map((t) => [turnKey(t), { fromRoad: t.fromRoad, via: t.via, toRoad: t.toRoad }])),
        selection: null,
        pendingRoadFrom: null,
        nextNodeNum: nextCounter(nodes.keys(), 'n'),
        nextRoadNum: nextCounter(edges.keys(), 'r'),
      };
    };

    return {
      ...networkState(initial, endpoints),
      tool: 'select',
      trafficBrush: 3,
      showLabels: false,
      version: 0,
      structureVersion: 0,
      fitRequest: 0,

      setTool: (tool) => set({ tool, pendingRoadFrom: null }),
      setTrafficBrush: (level) => set({ trafficBrush: level }),
      select: (selection) => set({ selection }),
      setPendingRoadFrom: (pendingRoadFrom) => set({ pendingRoadFrom }),
      toggleLabels: () => set({ showLabels: !get().showLabels }),
      requestFit: () => set({ fitRequest: get().fitRequest + 1 }),

      addNode: (x, y) => {
        const s = get();
        let num = s.nextNodeNum;
        while (s.nodes.has(`n${num}`)) num++;
        const id = `n${num}`;
        const nodes = new Map(s.nodes);
        nodes.set(id, { id, x, y, blocked: false });
        commit({ nodes, nextNodeNum: num + 1 }, true);
        return id;
      },

      addRoad: (from, to) => {
        const s = get();
        const a = s.nodes.get(from);
        const b = s.nodes.get(to);
        if (!a || !b || from === to) return null;
        const existing = findRoadBetween(s.edges, from, to);
        if (existing) return existing.id;

        let num = s.nextRoadNum;
        while (s.edges.has(`r${num}`)) num++;
        const id = `r${num}`;
        const edges = new Map(s.edges);
        edges.set(id, {
          id,
          from,
          to,
          distance: defaultRoadDistance(a, b),
          trafficLevel: 1,
          oneWay: false,
          closed: false,
        });
        commit({ edges, nextRoadNum: num + 1 }, true);
        return id;
      },

      moveNode: (id, x, y) => {
        const s = get();
        const old = s.nodes.get(id);
        if (!old || (old.x === x && old.y === y)) return;

        const nodes = new Map(s.nodes);
        nodes.set(id, { ...old, x, y });

        // Connected roads keep their winding ratio (distance / straight-line length),
        // so a straight road stays straight and distance never drops below the new
        // straight-line length.
        const edges = new Map(s.edges);
        for (const e of s.edges.values()) {
          if (e.from !== id && e.to !== id) continue;
          const otherId = e.from === id ? e.to : e.from;
          const other = s.nodes.get(otherId);
          if (!other) continue;
          const oldStraight = Math.max(euclidean(old.x, old.y, other.x, other.y), MIN_ROAD_DISTANCE);
          const newStraight = Math.max(euclidean(x, y, other.x, other.y), MIN_ROAD_DISTANCE);
          const ratio = Math.max(1, e.distance / oldStraight);
          edges.set(e.id, { ...e, distance: newStraight * ratio });
        }
        commit({ nodes, edges }, true);
      },

      deleteNode: (id) => {
        const s = get();
        if (!s.nodes.has(id)) return;
        const nodes = new Map(s.nodes);
        nodes.delete(id);
        const edges = new Map(s.edges);
        const removedEdges = new Set<string>();
        for (const e of s.edges.values()) {
          if (e.from === id || e.to === id) {
            edges.delete(e.id);
            removedEdges.add(e.id);
          }
        }
        commit({ nodes, edges, ...forget(s, new Set([id]), removedEdges) }, true);
      },

      deleteEdge: (id) => {
        const s = get();
        if (!s.edges.has(id)) return;
        const edges = new Map(s.edges);
        edges.delete(id);
        commit({ edges, ...forget(s, new Set(), new Set([id])) }, true);
      },

      deleteSelection: () => {
        const sel = get().selection;
        if (!sel) return;
        if (sel.kind === 'node') get().deleteNode(sel.id);
        else get().deleteEdge(sel.id);
      },

      setNodeLabel: (id, label) => {
        const trimmed = label.trim();
        updateNode(
          id,
          (n) => {
            const { label: _old, ...rest } = n;
            return trimmed ? { ...rest, label: trimmed } : rest;
          },
          false,
        );
      },

      setBlocked: (nodeId, blocked) => {
        if (get().nodes.get(nodeId)?.blocked === blocked) return;
        updateNode(nodeId, (n) => ({ ...n, blocked }), false);
      },
      toggleBlocked: (nodeId) => {
        const n = get().nodes.get(nodeId);
        if (n) get().setBlocked(nodeId, !n.blocked);
      },

      setTraffic: (edgeId, level) => {
        if (!isTrafficLevel(level) || get().edges.get(edgeId)?.trafficLevel === level) return;
        updateEdge(edgeId, (e) => ({ ...e, trafficLevel: level }), false);
      },

      setClosed: (edgeId, closed) => {
        if (get().edges.get(edgeId)?.closed === closed) return;
        updateEdge(edgeId, (e) => ({ ...e, closed }), false);
      },
      toggleClosed: (edgeId) => {
        const e = get().edges.get(edgeId);
        if (e) get().setClosed(edgeId, !e.closed);
      },

      reopen: (roadIds, nodeIds) => {
        const s = get();
        let edges: Map<string, GraphEdge> | null = null;
        for (const id of roadIds) {
          const e = s.edges.get(id);
          if (!e?.closed) continue;
          edges ??= new Map(s.edges);
          edges.set(id, { ...e, closed: false });
        }
        let nodes: Map<string, GraphNode> | null = null;
        for (const id of nodeIds) {
          const n = s.nodes.get(id);
          if (!n?.blocked) continue;
          nodes ??= new Map(s.nodes);
          nodes.set(id, { ...n, blocked: false });
        }
        if (!edges && !nodes) return;
        commit({ ...(edges ? { edges } : {}), ...(nodes ? { nodes } : {}) }, false);
      },

      setOneWay: (edgeId, oneWay) => {
        if (get().edges.get(edgeId)?.oneWay === oneWay) return;
        updateEdge(edgeId, (e) => ({ ...e, oneWay }), true);
      },
      reverseEdge: (edgeId) => updateEdge(edgeId, (e) => ({ ...e, from: e.to, to: e.from }), true),

      cycleDirection: (edgeId) => {
        // The "canonical" orientation is from the lexicographically smaller id,
        // which lets the cycle position be read from the edge alone.
        updateEdge(
          edgeId,
          (e) => {
            const canonical = e.from < e.to;
            if (!e.oneWay) {
              return canonical ? { ...e, oneWay: true } : { ...e, oneWay: true, from: e.to, to: e.from };
            }
            if (canonical) return { ...e, from: e.to, to: e.from }; // one-way -> reversed
            return { ...e, oneWay: false }; // reversed -> two-way
          },
          true,
        );
      },

      setEdgeDistance: (edgeId, distance) => {
        const s = get();
        const e = s.edges.get(edgeId);
        if (!e || !Number.isFinite(distance) || distance <= 0) return null;
        const a = s.nodes.get(e.from);
        const b = s.nodes.get(e.to);
        if (!a || !b) return null;
        const applied = Math.max(distance, minAllowedDistance(a, b));
        if (applied !== e.distance) updateEdge(edgeId, (old) => ({ ...old, distance: applied }), true);
        return applied;
      },

      setStart: (nodeId) => {
        if (nodeId !== null && !get().nodes.has(nodeId)) return;
        set({ start: nodeId });
      },
      setEnd: (nodeId) => {
        if (nodeId !== null && !get().nodes.has(nodeId)) return;
        set({ end: nodeId });
      },

      toggleWaypoint: (nodeId) => {
        const s = get();
        if (!s.nodes.has(nodeId)) return;
        if (s.waypoints.includes(nodeId)) set({ waypoints: s.waypoints.filter((id) => id !== nodeId) });
        else if (s.waypoints.length < MAX_WAYPOINTS) set({ waypoints: [...s.waypoints, nodeId] });
      },
      moveWaypoint: (index, offset) => {
        const list = [...get().waypoints];
        const to = index + offset;
        if (index < 0 || index >= list.length || to < 0 || to >= list.length) return;
        [list[index], list[to]] = [list[to] as string, list[index] as string];
        set({ waypoints: list });
      },
      removeWaypoint: (index) => {
        const list = get().waypoints;
        if (index < 0 || index >= list.length) return;
        set({ waypoints: list.filter((_, i) => i !== index) });
      },
      clearWaypoints: () => {
        if (get().waypoints.length > 0) set({ waypoints: [] });
      },

      toggleTurnRestriction: (turn) => {
        const s = get();
        const from = s.edges.get(turn.fromRoad);
        const to = s.edges.get(turn.toRoad);
        const meets = (e: GraphEdge) => e.from === turn.via || e.to === turn.via;
        if (!from || !to || !s.nodes.has(turn.via) || !meets(from) || !meets(to)) return;
        const key = turnKey(turn);
        const turnRestrictions = new Map(s.turnRestrictions);
        if (turnRestrictions.has(key)) turnRestrictions.delete(key);
        else turnRestrictions.set(key, { fromRoad: turn.fromRoad, via: turn.via, toRoad: turn.toRoad });
        commit({ turnRestrictions }, false);
      },
      clearTurnRestrictions: (viaNodeId) => {
        const s = get();
        const kept = [...s.turnRestrictions].filter(([, t]) => viaNodeId !== undefined && t.via !== viaNodeId);
        if (kept.length === s.turnRestrictions.size) return;
        commit({ turnRestrictions: new Map(kept) }, false);
      },

      applyTrafficPreset: (preset) => {
        const s = get();
        const levels = presetTraffic(preset, s.nodes, s.edges);
        let edges: Map<string, GraphEdge> | null = null;
        let changed = 0;
        for (const [id, level] of levels) {
          const e = s.edges.get(id) as GraphEdge;
          if (e.trafficLevel === level) continue;
          edges ??= new Map(s.edges);
          edges.set(id, { ...e, trafficLevel: level });
          changed++;
        }
        if (edges) commit({ edges }, false);
        return changed;
      },

      loadNetwork: (network, extras = {}) => {
        commit({ ...networkState(network, extras), fitRequest: get().fitRequest + 1 }, true);
      },

      clearMap: () => get().loadNetwork({ nodes: [], edges: [] }),
    };
  });
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

let cachedNetwork: { nodes: MapState['nodes']; edges: MapState['edges']; network: RoadNetwork } | null = null;

/** The current map as a RoadNetwork (arrays). Memoized on the Maps' identity. */
export function selectNetwork(s: Pick<MapState, 'nodes' | 'edges'>): RoadNetwork {
  if (cachedNetwork && cachedNetwork.nodes === s.nodes && cachedNetwork.edges === s.edges) {
    return cachedNetwork.network;
  }
  const network = { nodes: [...s.nodes.values()], edges: [...s.edges.values()] };
  cachedNetwork = { nodes: s.nodes, edges: s.edges, network };
  return network;
}

// ---------------------------------------------------------------------------
// App singleton
// ---------------------------------------------------------------------------

const demo = demoMap();
export const mapStore = createMapStore(demo.network, { start: demo.start, end: demo.end });

/** The current map as a saveable document. */
export function selectDocument(s: MapState) {
  return {
    network: selectNetwork(s),
    start: s.start,
    end: s.end,
    waypoints: [...s.waypoints],
    turnRestrictions: [...s.turnRestrictions.values()],
  };
}

/** React hook: subscribe to a slice of the app's map store. */
export function useMapStore<T>(selector: (s: MapState) => T): T {
  return useStore(mapStore, selector);
}
