import { expect } from 'vitest';
import type { GraphEdge, GraphNode, RoadNetwork, SearchResult, TrafficLevel } from '../core/graph';
import { defaultRoadDistance, edgeCost } from '../core/graph';

/** Compact node spec for tests: [id, x, y] or [id, x, y, blocked]. */
export type NodeSpec = [id: string, x: number, y: number, blocked?: boolean];

/** Compact road spec for tests. `distance` defaults to the straight-line length. */
export interface RoadSpec {
  from: string;
  to: string;
  distance?: number;
  traffic?: TrafficLevel;
  oneWay?: boolean;
  closed?: boolean;
  id?: string;
}

/** Builds a RoadNetwork from compact specs. Road ids default to "from-to". */
export function makeNetwork(nodeSpecs: NodeSpec[], roadSpecs: RoadSpec[]): RoadNetwork {
  const nodes: GraphNode[] = nodeSpecs.map(([id, x, y, blocked]) => ({ id, x, y, blocked: blocked ?? false }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: GraphEdge[] = roadSpecs.map((s) => {
    const a = byId.get(s.from);
    const b = byId.get(s.to);
    const fallback = a && b ? defaultRoadDistance(a, b) : 1;
    return {
      id: s.id ?? `${s.from}-${s.to}`,
      from: s.from,
      to: s.to,
      distance: s.distance ?? fallback,
      trafficLevel: s.traffic ?? 1,
      oneWay: s.oneWay ?? false,
      closed: s.closed ?? false,
    };
  });

  return { nodes, edges };
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomNetworkOptions {
  nodes: number;
  roads: number;
  /** Probability that a road is one-way. */
  oneWayRate?: number;
  /** Probability that a road starts closed. */
  closedRate?: number;
  /** Probability that an intersection is blocked. */
  blockedRate?: number;
  /** Side length of the square the nodes are placed in. */
  size?: number;
}

/**
 * Random road network that always satisfies validation: road distance is the
 * straight-line length (min 1) stretched by up to 50%, so it is never shorter
 * than the straight line. Mixes traffic, one-way, closed and blocked elements.
 */
export function randomNetwork(rand: () => number, opts: RandomNetworkOptions): RoadNetwork {
  const size = opts.size ?? 100;
  const nodes: GraphNode[] = [];
  for (let i = 0; i < opts.nodes; i++) {
    nodes.push({
      id: `n${i}`,
      x: Math.round(rand() * size),
      y: Math.round(rand() * size),
      blocked: rand() < (opts.blockedRate ?? 0),
    });
  }

  const edges: GraphEdge[] = [];
  if (opts.nodes >= 2) {
    for (let i = 0; i < opts.roads; i++) {
      const a = Math.floor(rand() * opts.nodes);
      let b = Math.floor(rand() * (opts.nodes - 1));
      if (b >= a) b++; // distinct endpoints, no self-loops
      const na = nodes[a] as GraphNode;
      const nb = nodes[b] as GraphNode;
      edges.push({
        id: `r${i}`,
        from: na.id,
        to: nb.id,
        distance: defaultRoadDistance(na, nb) * (1 + rand() * 0.5),
        trafficLevel: (1 + Math.floor(rand() * 4)) as TrafficLevel,
        oneWay: rand() < (opts.oneWayRate ?? 0),
        closed: rand() < (opts.closedRate ?? 0),
      });
    }
  }
  return { nodes, edges };
}

/**
 * Reference shortest-path cost via Bellman-Ford, computed directly on the
 * editable RoadNetwork. It is slow but simple and shares no code with the
 * compiled SearchGraph or the heap, so it is an independent oracle.
 * Returns Infinity when no route exists.
 */
export function referenceCost(network: RoadNetwork, startId: string, endId: string): number {
  const blocked = new Set(network.nodes.filter((n) => n.blocked).map((n) => n.id));
  if (blocked.has(startId) || blocked.has(endId)) return Infinity;

  // Directed arcs, skipping closed roads and arcs into blocked nodes.
  const arcs: Array<[string, string, number]> = [];
  for (const e of network.edges) {
    if (e.closed) continue;
    const c = edgeCost(e);
    if (!blocked.has(e.to)) arcs.push([e.from, e.to, c]);
    if (!e.oneWay && !blocked.has(e.from)) arcs.push([e.to, e.from, c]);
  }

  const dist = new Map<string, number>(network.nodes.map((n) => [n.id, Infinity]));
  dist.set(startId, 0);
  for (let i = 0; i < network.nodes.length; i++) {
    let changed = false;
    for (const [u, v, c] of arcs) {
      const du = dist.get(u) as number;
      if (du + c < (dist.get(v) as number)) {
        dist.set(v, du + c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return dist.get(endId) as number;
}

/**
 * Asserts that a found result describes a real, legal route in `network`:
 * consecutive nodes are joined by the listed road in an allowed direction,
 * no road is closed, no node is blocked, and the reported cost and distance
 * equal the sums along the path.
 */
export function expectValidRoute(network: RoadNetwork, result: SearchResult, startId: string, endId: string): void {
  expect(result.found).toBe(true);
  expect(result.path[0]).toBe(startId);
  expect(result.path[result.path.length - 1]).toBe(endId);
  expect(result.pathRoads.length).toBe(result.path.length - 1);

  const nodes = new Map(network.nodes.map((n) => [n.id, n]));
  const edges = new Map(network.edges.map((e) => [e.id, e]));
  let cost = 0;
  let distance = 0;

  for (const id of result.path) expect(nodes.get(id)?.blocked, `node ${id} is blocked`).toBe(false);

  result.pathRoads.forEach((roadId, i) => {
    const e = edges.get(roadId);
    if (!e) throw new Error(`unknown road ${roadId}`);
    const u = result.path[i];
    const v = result.path[i + 1];
    const forward = e.from === u && e.to === v;
    const backward = !e.oneWay && e.from === v && e.to === u;
    expect(forward || backward, `road ${roadId} does not lead ${u} -> ${v}`).toBe(true);
    expect(e.closed, `road ${roadId} is closed`).toBe(false);
    cost += edgeCost(e);
    distance += e.distance;
  });

  expect(result.cost).toBeCloseTo(cost, 9);
  expect(result.distance).toBeCloseTo(distance, 9);
}

/** w x h grid with unit spacing `step`; every node joined to its right and lower neighbour. */
export function gridNetwork(w: number, h: number, step = 10): RoadNetwork {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const id = (x: number, y: number) => `g${x}_${y}`;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      nodes.push({ id: id(x, y), x: x * step, y: y * step, blocked: false });
      if (x + 1 < w) edges.push({ id: `h${x}_${y}`, from: id(x, y), to: id(x + 1, y), distance: step, trafficLevel: 1, oneWay: false, closed: false });
      if (y + 1 < h) edges.push({ id: `v${x}_${y}`, from: id(x, y), to: id(x, y + 1), distance: step, trafficLevel: 1, oneWay: false, closed: false });
    }
  }
  return { nodes, edges };
}
