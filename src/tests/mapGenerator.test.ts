import { describe, expect, it } from 'vitest';
import { compileGraph, validateNetwork, type GraphNode } from '../core/graph';
import { analyzeNetwork } from '../core/traversal';
import { demoMap, generateGeometricMap, generateGridMap, generateMap } from '../utils/mapGenerator';
import { presetTraffic } from '../utils/trafficPresets';

describe('generateGridMap', () => {
  it('produces valid networks across many seeds', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { network, start, end } = generateGridMap({ cols: 12, rows: 8, seed, oneWayRate: 0.3, windingRate: 0.5 });
      expect(validateNetwork(network), `seed ${seed}`).toEqual([]);
      expect(network.nodes).toHaveLength(96);
      expect(network.nodes.some((n) => n.id === start)).toBe(true);
      expect(network.nodes.some((n) => n.id === end)).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    expect(generateGridMap({ cols: 6, rows: 6, seed: 9 })).toEqual(generateGridMap({ cols: 6, rows: 6, seed: 9 }));
    expect(generateGridMap({ cols: 6, rows: 6, seed: 9 })).not.toEqual(generateGridMap({ cols: 6, rows: 6, seed: 10 }));
  });

  it('mixes traffic levels and one-way roads', () => {
    const { network } = generateGridMap({ cols: 20, rows: 20, seed: 1 });
    const levels = new Set(network.edges.map((e) => e.trafficLevel));
    expect(levels).toEqual(new Set([1, 2, 3, 4]));
    expect(network.edges.some((e) => e.oneWay)).toBe(true);
  });

  it('demo map is valid', () => {
    expect(validateNetwork(demoMap().network)).toEqual([]);
  });
});

describe('generateGeometricMap (random geometric graph)', () => {
  it('is valid, has the exact node count, and is a single connected region', () => {
    for (const nodes of [1, 2, 7, 150, 1000]) {
      const { network, start, end } = generateGeometricMap({ nodes, seed: nodes });
      expect(validateNetwork(network), `${nodes} nodes`).toEqual([]);
      expect(network.nodes).toHaveLength(nodes);
      const report = analyzeNetwork(compileGraph({ ...network, edges: network.edges.map((e) => ({ ...e, oneWay: false })) }));
      expect(report.regions, `${nodes} nodes`).toBe(1);
      expect(network.nodes.some((n) => n.id === start) && network.nodes.some((n) => n.id === end)).toBe(true);
    }
  });

  it('is planar: no two roads cross', () => {
    const { network } = generateGeometricMap({ nodes: 400, seed: 2 });
    const pos = new Map(network.nodes.map((n) => [n.id, n]));
    const cross = (a: GraphNode, b: GraphNode, c: GraphNode, d: GraphNode) => {
      const o = (p: GraphNode, q: GraphNode, r: GraphNode) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    const segs = network.edges.map((e) => [pos.get(e.from) as GraphNode, pos.get(e.to) as GraphNode] as const);
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = segs[i]!;
        const [c, d] = segs[j]!;
        if (a === c || a === d || b === c || b === d) continue;
        if (cross(a, b, c, d)) crossings++;
      }
    }
    expect(crossings).toBe(0);
  });

  it('is deterministic per seed and has a street-like average degree', () => {
    expect(generateGeometricMap({ nodes: 300, seed: 5 })).toEqual(generateGeometricMap({ nodes: 300, seed: 5 }));
    const { network } = generateGeometricMap({ nodes: 2000, seed: 5 });
    const degree = (2 * network.edges.length) / network.nodes.length;
    expect(degree).toBeGreaterThan(3.5);
    expect(degree).toBeLessThan(6);
  });

  it('generateMap picks the generator and approximates the size', () => {
    expect(generateMap('geometric', 1000, 1).network.nodes).toHaveLength(1000);
    const grid = generateMap('grid', 1000, 1).network.nodes.length;
    expect(Math.abs(grid - 1000)).toBeLessThan(60);
  });
});

describe('time-of-day traffic presets', () => {
  const city = () => {
    const { network } = generateGeometricMap({ nodes: 3000, seed: 8 });
    return { nodes: new Map(network.nodes.map((n) => [n.id, n])), edges: new Map(network.edges.map((e) => [e.id, e])) };
  };
  const share = (levels: Map<string, number>, pred: (l: number) => boolean) => [...levels.values()].filter(pred).length / levels.size;

  it('night is almost free-flowing; rush hour is much heavier than midday', () => {
    const { nodes, edges } = city();
    const night = presetTraffic('night', nodes, edges);
    const midday = presetTraffic('midday', nodes, edges);
    const rush = presetTraffic('rush', nodes, edges);
    expect(night.size).toBe(edges.size);
    expect(share(night, (l) => l === 1)).toBeGreaterThan(0.9);
    expect(share(rush, (l) => l >= 3)).toBeGreaterThan(share(midday, (l) => l >= 3) * 1.5);
  });

  it('rush hour concentrates congestion in the centre', () => {
    const { nodes, edges } = city();
    const rush = presetTraffic('rush', nodes, edges);
    const xs = [...nodes.values()].map((n) => n.x);
    const ys = [...nodes.values()].map((n) => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const near: number[] = [];
    const far: number[] = [];
    for (const e of edges.values()) {
      const a = nodes.get(e.from)!;
      const d = Math.hypot(a.x - cx, a.y - cy);
      (d < 600 ? near : far).push(rush.get(e.id) as number);
    }
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    expect(mean(near)).toBeGreaterThan(mean(far) + 1);
  });

  it('is deterministic (a hash of the road id, not a random draw)', () => {
    const { nodes, edges } = city();
    expect(presetTraffic('midday', nodes, edges)).toEqual(presetTraffic('midday', nodes, edges));
  });
});
