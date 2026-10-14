import { describe, expect, it } from 'vitest';
import { euclidean } from '../core/graph';
import { createMapStore, selectDocument } from '../state/mapStore';
import { generateGeometricMap } from '../utils/mapGenerator';
import { MAP_FORMAT, parseMap, serializeMap } from '../utils/serialization';
import { makeNetwork } from './helpers';

const sample = () => ({
  network: makeNetwork(
    [['A', 0, 0], ['B', 10, 0], ['C', 20, 0, true]],
    [
      { from: 'A', to: 'B', id: 'ab', traffic: 3, oneWay: true },
      { from: 'B', to: 'C', id: 'bc', distance: 14.5, closed: true },
    ],
  ),
  start: 'A',
  end: 'C',
  waypoints: ['B'],
  turnRestrictions: [{ fromRoad: 'ab', via: 'B', toRoad: 'bc' }],
});

const parseOk = (text: string) => {
  const r = parseMap(text);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
};

describe('save / load', () => {
  it('round-trips a map with pins, stops, closures, obstacles and turn restrictions', () => {
    const doc = sample();
    const text = serializeMap(doc, new Date('2026-10-14T12:00:00Z'));
    const saved = JSON.parse(text);
    expect(saved).toMatchObject({ format: MAP_FORMAT, version: 1, savedAt: '2026-10-14T12:00:00.000Z' });
    const r = parseOk(text);
    expect(r.warnings).toEqual([]);
    expect(r.map).toEqual(doc);
  });

  it('round-trips through the store, and a large generated map exactly', () => {
    const { network, start, end } = generateGeometricMap({ nodes: 2000, seed: 4 });
    const store = createMapStore(network, { start, end });
    store.getState().toggleWaypoint('n500');
    const text = serializeMap(selectDocument(store.getState()));
    expect(text.includes('\n')).toBe(false); // large maps are written compactly
    const loaded = createMapStore();
    const { network: net2, ...extras } = parseOk(text).map;
    loaded.getState().loadNetwork(net2, extras);
    const a = loaded.getState();
    expect([...a.nodes.values()]).toEqual(network.nodes);
    expect([...a.edges.values()]).toEqual(network.edges);
    expect([a.start, a.end, a.waypoints]).toEqual([start, end, ['n500']]);
  });

  it('accepts a bare { nodes, edges } object and fills in defaults', () => {
    const r = parseOk(JSON.stringify({ nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 4 }], edges: [{ id: 'r', from: 'a', to: 'b' }] }));
    expect(r.map.network.edges[0]).toEqual({ id: 'r', from: 'a', to: 'b', distance: 5, trafficLevel: 1, oneWay: false, closed: false });
    expect(r.map.network.nodes[0]).toEqual({ id: 'a', x: 0, y: 0, blocked: false });
    expect(r.map).toMatchObject({ start: null, end: null, waypoints: [], turnRestrictions: [] });
  });

  it('raises distances below the straight line, with a warning (keeps A* admissible)', () => {
    const r = parseOk(JSON.stringify({ nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 30, y: 40 }], edges: [{ id: 'r', from: 'a', to: 'b', distance: 10 }] }));
    expect(r.map.network.edges[0]?.distance).toBe(euclidean(0, 0, 30, 40));
    expect(r.warnings.join(' ')).toMatch(/1 road distance was shorter than the straight line/);
  });

  it('drops pins, stops and turn restrictions that point at missing elements, with warnings', () => {
    const doc = { ...JSON.parse(serializeMap(sample())), start: 'nope', waypoints: ['B', 'ghost'], turnRestrictions: [{ fromRoad: 'ab', via: 'B', toRoad: 'zz' }] };
    const r = parseOk(JSON.stringify(doc));
    expect(r.map.start).toBeNull();
    expect(r.map.waypoints).toEqual(['B']);
    expect(r.map.turnRestrictions).toEqual([]);
    expect(r.warnings).toHaveLength(3);
  });

  it.each([
    ['not JSON', '{nodes: [', /Not valid JSON/],
    ['not an object', '[1, 2]', /Expected a JSON object/],
    ['missing arrays', '{"nodes": []}', /"nodes" and "edges" arrays/],
    ['foreign format', '{"format": "geojson", "nodes": [], "edges": []}', /Unknown file format/],
    ['newer version', `{"format": "${MAP_FORMAT}", "version": 99, "nodes": [], "edges": []}`, /newer version/],
    ['node without coordinates', '{"nodes": [{"id": "a"}], "edges": []}', /needs numeric "x" and "y"/],
    ['bad traffic level', '{"nodes": [{"id":"a","x":0,"y":0},{"id":"b","x":1,"y":0}], "edges": [{"id":"r","from":"a","to":"b","trafficLevel":7}]}', /traffic level 7/],
    ['road to a missing intersection', '{"nodes": [{"id":"a","x":0,"y":0}], "edges": [{"id":"r","from":"a","to":"b"}]}', /missing intersection/],
    ['duplicate ids', '{"nodes": [{"id":"a","x":0,"y":0},{"id":"a","x":1,"y":0}], "edges": []}', /Duplicate intersection id/],
    ['self-loop', '{"nodes": [{"id":"a","x":0,"y":0}], "edges": [{"id":"r","from":"a","to":"a"}]}', /same intersection/],
  ])('rejects %s', (_name, text, pattern) => {
    const r = parseMap(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(pattern);
  });

  it('caps long error lists', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
    const r = parseMap(JSON.stringify({ nodes, edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(9);
      expect(r.errors[8]).toBe('…and 12 more.');
    }
  });
});
