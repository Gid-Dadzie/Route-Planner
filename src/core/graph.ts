/**
 * Graph model for the route planner.
 *
 * Two representations are used:
 *
 * 1. `RoadNetwork` — the editable, serializable model the UI works with.
 *    Nodes are intersections, edges are roads. A two-way road is ONE GraphEdge
 *    with `oneWay: false`; ids are strings.
 *
 * 2. `SearchGraph` — a compiled, read-mostly adjacency list for the search
 *    algorithms. Nodes and roads get dense numeric indices, and adjacency is
 *    packed in CSR form (offsets + flat arrays) backed by typed arrays. Each
 *    two-way road becomes two directed arcs; a one-way road becomes one.
 *
 * Every arc stores the index of the road it came from, and per-road state
 * (closed flag, traffic level, cached cost) lives in per-road typed arrays.
 * So a delta like "close road r" or "set traffic on r" is an O(1) write that
 * affects both directions at once, with no rebuild.
 *
 * Pure TypeScript: no React, no DOM. Runs on the main thread and in the worker.
 */

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

export type TrafficLevel = 1 | 2 | 3 | 4;

export interface TrafficInfo {
  readonly label: string;
  readonly color: string;
  readonly multiplier: number;
}

/** Cost multipliers per traffic level. All are >= 1 so the A* heuristic stays admissible. */
export const TRAFFIC_LEVELS: Readonly<Record<TrafficLevel, TrafficInfo>> = {
  1: { label: 'Free flow', color: '#22c55e', multiplier: 1.0 },
  2: { label: 'Moderate', color: '#eab308', multiplier: 1.5 },
  3: { label: 'Heavy', color: '#f97316', multiplier: 2.5 },
  4: { label: 'Gridlock', color: '#ef4444', multiplier: 4.0 },
};

/** Lookup table indexed by traffic level (index 0 unused) for hot paths. */
const MULTIPLIER_BY_LEVEL: readonly number[] = [
  NaN,
  TRAFFIC_LEVELS[1].multiplier,
  TRAFFIC_LEVELS[2].multiplier,
  TRAFFIC_LEVELS[3].multiplier,
  TRAFFIC_LEVELS[4].multiplier,
];

export function trafficMultiplier(level: TrafficLevel): number {
  return MULTIPLIER_BY_LEVEL[level];
}

export function isTrafficLevel(value: unknown): value is TrafficLevel {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// ---------------------------------------------------------------------------
// Editable model
// ---------------------------------------------------------------------------

/** An intersection. */
export interface GraphNode {
  id: string;
  x: number;
  y: number;
  /** Obstacle on the intersection: no route may pass through it. */
  blocked: boolean;
  label?: string;
}

/** A road between two intersections. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Length in world units. Must be > 0 and >= the Euclidean length of the road. */
  distance: number;
  trafficLevel: TrafficLevel;
  /** If true, the road can only be travelled from `from` to `to`. */
  oneWay: boolean;
  closed: boolean;
  speedLimit?: number;
}

/** The full editable road network. This is also the shape sent to the worker. */
export interface RoadNetwork {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Alias used by the worker protocol (doc §6.2). */
export type SerializedGraph = RoadNetwork;

// ---------------------------------------------------------------------------
// Search result types (shared by all algorithms, defined here so every phase
// codes against the same shape)
// ---------------------------------------------------------------------------

export type AlgorithmId = 'dijkstra' | 'astar' | 'bidirectional' | 'dstarlite';

export interface SearchResult {
  /** Node ids from start to end inclusive; empty when not found. */
  path: string[];
  /** Road ids travelled, in order (length = path.length - 1). Used to test "is this road on the route?". */
  pathRoads: string[];
  /** Total cost of `path` (distance x traffic). Infinity when not found. */
  cost: number;
  /** Total physical length of `path`, ignoring traffic. 0 when not found. */
  distance: number;
  found: boolean;
  /** Node ids in the order they were settled (expanded), for the wave animation. */
  exploredInOrder: string[];
  /** Which direction settled each node (aligned with exploredInOrder): 0 = forward from the start, 1 = backward from the end. Bidirectional search and D* Lite only. */
  exploredSides?: Uint8Array;
  nodesExplored: number;
  timeMs: number;
}

// ---------------------------------------------------------------------------
// Geometry and cost
// ---------------------------------------------------------------------------

/**
 * Smallest allowed road distance. Two intersections placed on the same spot
 * still get a strictly positive road length, so every cost is > 0.
 */
export const MIN_ROAD_DISTANCE = 1;

/** Relative tolerance when checking distance >= Euclidean length. */
const DISTANCE_EPSILON = 1e-9;

export function euclidean(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function nodeDistance(a: GraphNode, b: GraphNode): number {
  return euclidean(a.x, a.y, b.x, b.y);
}

/** Default length for a new road: its straight-line length, never below the minimum. */
export function defaultRoadDistance(a: GraphNode, b: GraphNode): number {
  return Math.max(nodeDistance(a, b), MIN_ROAD_DISTANCE);
}

/**
 * Smallest distance a road between `a` and `b` may have. Used by the editor
 * to clamp user input so the A* heuristic stays admissible.
 */
export function minAllowedDistance(a: GraphNode, b: GraphNode): number {
  return defaultRoadDistance(a, b);
}

/** cost(edge) = distance x trafficMultiplier(trafficLevel). */
export function edgeCost(edge: Pick<GraphEdge, 'distance' | 'trafficLevel'>): number {
  return edge.distance * trafficMultiplier(edge.trafficLevel);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationCode =
  | 'duplicate-node-id'
  | 'duplicate-edge-id'
  | 'invalid-coordinates'
  | 'missing-endpoint'
  | 'self-loop'
  | 'non-positive-distance'
  | 'distance-below-euclidean'
  | 'invalid-traffic-level';

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/**
 * Checks every invariant the algorithms rely on. Returns an empty array when
 * the network is valid.
 *
 * - Ids are unique; coordinates are finite.
 * - Every road connects two different, existing intersections.
 * - distance is finite and > 0 (so all costs are positive: Dijkstra/A* safe).
 * - distance >= Euclidean length (so the Euclidean A* heuristic never overestimates).
 * - trafficLevel is 1..4.
 */
export function validateNetwork(network: RoadNetwork): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodesById = new Map<string, GraphNode>();

  for (const node of network.nodes) {
    if (nodesById.has(node.id)) {
      issues.push({ code: 'duplicate-node-id', message: `Duplicate intersection id "${node.id}"`, nodeId: node.id });
      continue;
    }
    nodesById.set(node.id, node);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      issues.push({ code: 'invalid-coordinates', message: `Intersection "${node.id}" has invalid coordinates`, nodeId: node.id });
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of network.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ code: 'duplicate-edge-id', message: `Duplicate road id "${edge.id}"`, edgeId: edge.id });
      continue;
    }
    edgeIds.add(edge.id);

    const a = nodesById.get(edge.from);
    const b = nodesById.get(edge.to);
    if (!a || !b) {
      issues.push({ code: 'missing-endpoint', message: `Road "${edge.id}" references a missing intersection`, edgeId: edge.id });
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({ code: 'self-loop', message: `Road "${edge.id}" starts and ends at the same intersection`, edgeId: edge.id });
      continue;
    }
    if (!isTrafficLevel(edge.trafficLevel)) {
      issues.push({ code: 'invalid-traffic-level', message: `Road "${edge.id}" has invalid traffic level ${String(edge.trafficLevel)}`, edgeId: edge.id });
    }
    if (!Number.isFinite(edge.distance) || edge.distance <= 0) {
      issues.push({ code: 'non-positive-distance', message: `Road "${edge.id}" must have a positive distance`, edgeId: edge.id });
      continue;
    }
    const straight = nodeDistance(a, b);
    if (edge.distance < straight * (1 - DISTANCE_EPSILON)) {
      issues.push({
        code: 'distance-below-euclidean',
        message: `Road "${edge.id}" distance ${edge.distance.toFixed(2)} is shorter than its straight-line length ${straight.toFixed(2)}`,
        edgeId: edge.id,
      });
    }
  }

  return issues;
}

export class GraphValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Invalid road network: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'GraphValidationError';
  }
}

// ---------------------------------------------------------------------------
// Compiled search graph
// ---------------------------------------------------------------------------

/**
 * Packed adjacency list (CSR). Arcs leaving node `u` occupy indices
 * `offsets[u] .. offsets[u + 1] - 1` of `target` and `road`.
 */
export interface Adjacency {
  /** Length nodeCount + 1. */
  readonly offsets: Int32Array;
  /** Neighbour node index for each arc. */
  readonly target: Int32Array;
  /** Index of the road each arc belongs to (for closed/cost lookups). */
  readonly road: Int32Array;
}

export interface SearchGraph {
  readonly nodeCount: number;
  readonly roadCount: number;

  // Node data, indexed by node index.
  readonly nodeIds: readonly string[];
  readonly nodeIndex: ReadonlyMap<string, number>;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** 1 = blocked (obstacle). Mutable via setNodeBlocked. */
  readonly blocked: Uint8Array;

  // Road data, indexed by road index.
  readonly roadIds: readonly string[];
  readonly roadIndex: ReadonlyMap<string, number>;
  readonly roadFrom: Int32Array;
  readonly roadTo: Int32Array;
  readonly roadDistance: Float64Array;
  /** Traffic level 1..4. Mutable via setRoadTraffic. */
  readonly roadTraffic: Uint8Array;
  /** 1 = closed. Mutable via setRoadClosed. */
  readonly roadClosed: Uint8Array;
  /** Cached distance x multiplier, kept in sync with roadTraffic. */
  readonly roadCost: Float64Array;

  /** Forward arcs: u -> v. */
  readonly out: Adjacency;
  /** Reverse arcs: for each arc u -> v, an entry v <- u (target = u). Used by the backward search. */
  readonly in: Adjacency;
}

/**
 * Compiles an editable network into a SearchGraph.
 * Throws GraphValidationError if the network breaks any invariant.
 */
export function compileGraph(network: RoadNetwork): SearchGraph {
  const issues = validateNetwork(network);
  if (issues.length > 0) throw new GraphValidationError(issues);

  const nodeCount = network.nodes.length;
  const roadCount = network.edges.length;

  const nodeIds: string[] = new Array<string>(nodeCount);
  const nodeIndex = new Map<string, number>();
  const x = new Float64Array(nodeCount);
  const y = new Float64Array(nodeCount);
  const blocked = new Uint8Array(nodeCount);

  network.nodes.forEach((node, i) => {
    nodeIds[i] = node.id;
    nodeIndex.set(node.id, i);
    x[i] = node.x;
    y[i] = node.y;
    blocked[i] = node.blocked ? 1 : 0;
  });

  const roadIds: string[] = new Array<string>(roadCount);
  const roadIndex = new Map<string, number>();
  const roadFrom = new Int32Array(roadCount);
  const roadTo = new Int32Array(roadCount);
  const roadDistance = new Float64Array(roadCount);
  const roadTraffic = new Uint8Array(roadCount);
  const roadClosed = new Uint8Array(roadCount);
  const roadCost = new Float64Array(roadCount);

  // First pass: road arrays and degree counts.
  const outDegree = new Int32Array(nodeCount);
  const inDegree = new Int32Array(nodeCount);
  let arcCount = 0;

  network.edges.forEach((edge, r) => {
    const u = nodeIndex.get(edge.from) as number;
    const v = nodeIndex.get(edge.to) as number;
    roadIds[r] = edge.id;
    roadIndex.set(edge.id, r);
    roadFrom[r] = u;
    roadTo[r] = v;
    roadDistance[r] = edge.distance;
    roadTraffic[r] = edge.trafficLevel;
    roadClosed[r] = edge.closed ? 1 : 0;
    roadCost[r] = edgeCost(edge);

    outDegree[u]++;
    inDegree[v]++;
    arcCount++;
    if (!edge.oneWay) {
      outDegree[v]++;
      inDegree[u]++;
      arcCount++;
    }
  });

  // Second pass: fill CSR arrays.
  const out = allocateAdjacency(outDegree, arcCount);
  const inc = allocateAdjacency(inDegree, arcCount);
  const outCursor = out.offsets.slice(0, nodeCount);
  const inCursor = inc.offsets.slice(0, nodeCount);

  const addArc = (u: number, v: number, r: number): void => {
    const o = outCursor[u]++;
    out.target[o] = v;
    out.road[o] = r;
    const i = inCursor[v]++;
    inc.target[i] = u;
    inc.road[i] = r;
  };

  network.edges.forEach((edge, r) => {
    const u = roadFrom[r];
    const v = roadTo[r];
    addArc(u, v, r);
    if (!edge.oneWay) addArc(v, u, r);
  });

  return {
    nodeCount,
    roadCount,
    nodeIds,
    nodeIndex,
    x,
    y,
    blocked,
    roadIds,
    roadIndex,
    roadFrom,
    roadTo,
    roadDistance,
    roadTraffic,
    roadClosed,
    roadCost,
    out,
    in: inc,
  };
}

function allocateAdjacency(degree: Int32Array, arcCount: number): Adjacency {
  const n = degree.length;
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + degree[i];
  return { offsets, target: new Int32Array(arcCount), road: new Int32Array(arcCount) };
}

/**
 * True if the search may follow an arc of road `road` into node `target`.
 * Closed roads and arcs into blocked intersections are skipped (infinite cost).
 */
export function isArcOpen(g: SearchGraph, road: number, target: number): boolean {
  return g.roadClosed[road] === 0 && g.blocked[target] === 0;
}

// ---------------------------------------------------------------------------
// In-place mutations (used by the worker to apply deltas without recompiling)
// Each returns false if the id is unknown.
// ---------------------------------------------------------------------------

export function setRoadClosed(g: SearchGraph, roadId: string, closed: boolean): boolean {
  const r = g.roadIndex.get(roadId);
  if (r === undefined) return false;
  g.roadClosed[r] = closed ? 1 : 0;
  return true;
}

export function setRoadTraffic(g: SearchGraph, roadId: string, level: TrafficLevel): boolean {
  const r = g.roadIndex.get(roadId);
  if (r === undefined || !isTrafficLevel(level)) return false;
  g.roadTraffic[r] = level;
  g.roadCost[r] = g.roadDistance[r] * trafficMultiplier(level);
  return true;
}

export function setNodeBlocked(g: SearchGraph, nodeId: string, blocked: boolean): boolean {
  const i = g.nodeIndex.get(nodeId);
  if (i === undefined) return false;
  g.blocked[i] = blocked ? 1 : 0;
  return true;
}

/**
 * Moves a node. Coordinates only affect the A* heuristic; road costs are
 * updated separately via setRoadDistance (the editor recomputes distances).
 */
export function setNodePosition(g: SearchGraph, nodeId: string, x: number, y: number): boolean {
  const i = g.nodeIndex.get(nodeId);
  if (i === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  g.x[i] = x;
  g.y[i] = y;
  return true;
}

/** Changes a road's distance and its cached cost. Rejects non-positive values. */
export function setRoadDistance(g: SearchGraph, roadId: string, distance: number): boolean {
  const r = g.roadIndex.get(roadId);
  if (r === undefined || !Number.isFinite(distance) || distance <= 0) return false;
  g.roadDistance[r] = distance;
  g.roadCost[r] = distance * trafficMultiplier(g.roadTraffic[r] as TrafficLevel);
  return true;
}
