/**
 * Procedural road networks for demos and stress tests (100 to 10,000+ nodes):
 *
 * - `generateGridMap`: a jittered city grid with occasional diagonals.
 * - `generateGeometricMap`: a random geometric graph. Points are spread
 *   evenly at random (one per cell of a jittered grid, so none clump), then
 *   joined by a Gabriel graph: p and q are connected when no other point lies
 *   inside the circle whose diameter is pq. That graph is planar (no crossing
 *   roads), contains the minimum spanning tree (so it is connected) and has an
 *   average degree near 4, which looks and behaves like an organic street
 *   network.
 *
 * Every generated network passes validateNetwork: road distance is always at
 * least the straight-line length. Both generators are deterministic per seed.
 */

import { defaultRoadDistance, type GraphEdge, type GraphNode, type RoadNetwork, type TrafficLevel } from '../core/graph';

/** Deterministic PRNG (mulberry32): the same seed always yields the same map. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a traffic level using cumulative weights for levels 1..4. */
function pickTraffic(rand: () => number, weights: readonly [number, number, number, number]): TrafficLevel {
  const total = weights[0] + weights[1] + weights[2] + weights[3];
  let r = rand() * total;
  for (let level = 1; level <= 4; level++) {
    r -= weights[level - 1] as number;
    if (r < 0) return level as TrafficLevel;
  }
  return 4;
}

/** Road attributes shared by the generators. */
interface RoadStyle {
  /** Probability that a road is one-way. */
  oneWayRate: number;
  /** Probability that a road winds (distance up to 30% above straight-line). */
  windingRate: number;
  /** Relative frequency of traffic levels 1..4. */
  trafficWeights: readonly [number, number, number, number];
}

/** Returns a function that appends a road between two nodes to `edges`, with random attributes. */
function roadMaker(rand: () => number, edges: GraphEdge[], style: RoadStyle): (a: GraphNode, b: GraphNode) => void {
  return (a, b) => {
    const winding = rand() < style.windingRate ? 1 + rand() * 0.3 : 1;
    const oneWay = rand() < style.oneWayRate;
    // Randomise orientation so one-way streets point both ways across the map.
    const [from, to] = oneWay && rand() < 0.5 ? [b, a] : [a, b];
    edges.push({
      id: `r${edges.length}`,
      from: from.id,
      to: to.id,
      distance: Math.round(defaultRoadDistance(a, b) * winding * 10) / 10 + 0.1,
      trafficLevel: pickTraffic(rand, style.trafficWeights),
      oneWay,
      closed: false,
    });
  };
}

export interface GridMapOptions {
  cols: number;
  rows: number;
  /** Distance between grid lines in world units. */
  spacing?: number;
  /** Random offset per intersection, as a fraction of spacing. */
  jitter?: number;
  /** Probability that a grid road is left out (makes the city less regular). */
  removeRate?: number;
  /** Probability of a diagonal shortcut in each block. */
  diagonalRate?: number;
  /** Probability that a road is one-way. */
  oneWayRate?: number;
  /** Probability that a road winds (distance up to 30% above straight-line). */
  windingRate?: number;
  /** Relative frequency of traffic levels 1..4. */
  trafficWeights?: readonly [number, number, number, number];
  seed?: number;
}

export interface GeneratedMap {
  network: RoadNetwork;
  /** Suggested route endpoints: opposite corners. */
  start: string;
  end: string;
}

/** A jittered city grid with occasional diagonals, one-way streets and traffic. */
export function generateGridMap(opts: GridMapOptions): GeneratedMap {
  const {
    cols,
    rows,
    spacing = 80,
    jitter = 0.22,
    removeRate = 0.08,
    diagonalRate = 0.12,
    oneWayRate = 0.06,
    windingRate = 0.2,
    trafficWeights = [0.62, 0.22, 0.11, 0.05],
    seed = 1,
  } = opts;
  const rand = createRng(seed);

  const nodes: GraphNode[] = [];
  const nodeAt = (c: number, r: number): GraphNode => nodes[r * cols + c] as GraphNode;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push({
        id: `n${r * cols + c}`,
        x: Math.round(c * spacing + (rand() - 0.5) * 2 * jitter * spacing),
        y: Math.round(r * spacing + (rand() - 0.5) * 2 * jitter * spacing),
        blocked: false,
      });
    }
  }

  const edges: GraphEdge[] = [];
  const addRoad = roadMaker(rand, edges, { oneWayRate, windingRate, trafficWeights });

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const here = nodeAt(c, r);
      if (c + 1 < cols && rand() >= removeRate) addRoad(here, nodeAt(c + 1, r));
      if (r + 1 < rows && rand() >= removeRate) addRoad(here, nodeAt(c, r + 1));
      if (c + 1 < cols && r + 1 < rows && rand() < diagonalRate) {
        // Alternate diagonal direction for variety.
        if (rand() < 0.5) addRoad(here, nodeAt(c + 1, r + 1));
        else addRoad(nodeAt(c + 1, r), nodeAt(c, r + 1));
      }
    }
  }

  return {
    network: { nodes, edges },
    start: nodeAt(0, 0).id,
    end: nodeAt(cols - 1, rows - 1).id,
  };
}

export interface GeometricMapOptions {
  /** Number of intersections (exact). */
  nodes: number;
  /** Average distance between neighbouring intersections. */
  spacing?: number;
  /** Width / height of the map. */
  aspect?: number;
  oneWayRate?: number;
  windingRate?: number;
  trafficWeights?: readonly [number, number, number, number];
  seed?: number;
}

/** A random geometric road network: evenly spread random points joined by a Gabriel graph. */
export function generateGeometricMap(opts: GeometricMapOptions): GeneratedMap {
  const {
    nodes: count,
    spacing = 80,
    aspect = 1.6,
    oneWayRate = 0.05,
    windingRate = 0.25,
    trafficWeights = [0.62, 0.22, 0.11, 0.05],
    seed = 1,
  } = opts;
  if (count < 1) throw new Error('A map needs at least one intersection.');
  const rand = createRng(seed);

  // One point per cell, placed in the cell's middle 70% so neighbours never coincide.
  const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  const rows = Math.ceil(count / cols);
  const nodes: GraphNode[] = [];
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    xs[i] = Math.round((c + 0.15 + 0.7 * rand()) * spacing);
    ys[i] = Math.round((r + 0.15 + 0.7 * rand()) * spacing);
    nodes.push({ id: `n${i}`, x: xs[i] as number, y: ys[i] as number, blocked: false });
  }
  /** Point index in grid cell (c, r), or -1 outside the filled cells. */
  const at = (c: number, r: number): number => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    const i = r * cols + c;
    return i < count ? i : -1;
  };

  // Gabriel edges among points up to two cells apart. Longer Gabriel edges are
  // vanishingly rare with one point per cell; the repair pass covers any gap.
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const ci = i % cols;
    const ri = Math.floor(i / cols);
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const j = at(ci + dc, ri + dr);
        if (j <= i) continue; // each pair once
        if (isGabriel(i, j, xs, ys, spacing, at)) pairs.push([i, j]);
      }
    }
  }

  // Connectivity repair: join the component of node 0 to its nearest outside point until one remains.
  const uf = new UnionFind(count);
  for (const [i, j] of pairs) uf.union(i, j);
  while (uf.components > 1) {
    const root = uf.find(0);
    let best: [number, number] = [0, 0];
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      if (uf.find(i) !== root) continue;
      for (let j = 0; j < count; j++) {
        if (uf.find(j) === root) continue;
        const d = ((xs[i] as number) - (xs[j] as number)) ** 2 + ((ys[i] as number) - (ys[j] as number)) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [i, j];
        }
      }
    }
    pairs.push(best);
    uf.union(best[0], best[1]);
  }

  const edges: GraphEdge[] = [];
  const addRoad = roadMaker(rand, edges, { oneWayRate, windingRate, trafficWeights });
  for (const [i, j] of pairs) addRoad(nodes[i] as GraphNode, nodes[j] as GraphNode);

  // Endpoints: the intersections nearest the top-left and bottom-right corners.
  const nearest = (x: number, y: number): string => {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const d = ((xs[i] as number) - x) ** 2 + ((ys[i] as number) - y) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return (nodes[bestI] as GraphNode).id;
  };
  return { network: { nodes, edges }, start: nearest(0, 0), end: nearest(cols * spacing, rows * spacing) };
}

/** True if no other point lies strictly inside the circle with diameter (i, j). */
function isGabriel(
  i: number,
  j: number,
  xs: Float64Array,
  ys: Float64Array,
  spacing: number,
  at: (c: number, r: number) => number,
): boolean {
  const xi = xs[i] as number, yi = ys[i] as number, xj = xs[j] as number, yj = ys[j] as number;
  const mx = (xi + xj) / 2;
  const my = (yi + yj) / 2;
  const r2 = ((xi - xj) ** 2 + (yi - yj) ** 2) / 4;
  const reach = Math.ceil(Math.sqrt(r2) / spacing) + 1;
  const mc = Math.floor(mx / spacing);
  const mr = Math.floor(my / spacing);
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const k = at(mc + dc, mr + dr);
      if (k < 0 || k === i || k === j) continue;
      if (((xs[k] as number) - mx) ** 2 + ((ys[k] as number) - my) ** 2 < r2 * (1 - 1e-9)) return false;
    }
  }
  return true;
}

class UnionFind {
  private readonly parent: Int32Array;
  components: number;

  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.components = n;
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i] as number] as number; // path halving
      i = this.parent[i] as number;
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent[ra] = rb;
    this.components--;
  }
}

export type MapKind = 'grid' | 'geometric';

/** Sizes offered by the generator UI. */
export const MAP_SIZES: readonly number[] = [100, 1000, 2500, 5000, 10000];

/** A grid or geometric map with about `nodes` intersections (grids round to whole rows). */
export function generateMap(kind: MapKind, nodes: number, seed: number): GeneratedMap {
  if (kind === 'geometric') return generateGeometricMap({ nodes, seed });
  const cols = Math.max(2, Math.round(Math.sqrt(nodes * 1.6)));
  const rows = Math.max(2, Math.round(nodes / cols));
  return generateGridMap({ cols, rows, seed });
}

/** The map shown on first load. */
export function demoMap(): GeneratedMap {
  return generateGridMap({ cols: 14, rows: 9, seed: 7 });
}

