import { describe, expect, it } from 'vitest';
import { euclidean, validateNetwork, type GraphEdge } from '../core/graph';
import { createMapStore, MAX_WAYPOINTS, selectNetwork } from '../state/mapStore';
import { makeNetwork } from './helpers';

/** A--B (straight, 5 long) and B--C (winding: 20 for a straight-line 10). */
function sampleStore() {
  return createMapStore(
    makeNetwork(
      [['A', 0, 0], ['B', 3, 4], ['C', 13, 4]],
      [
        { from: 'A', to: 'B', id: 'r0' },
        { from: 'B', to: 'C', id: 'r1', distance: 20 },
      ],
    ),
    { start: 'A', end: 'C' },
  );
}

const edge = (store: ReturnType<typeof sampleStore>, id: string) => store.getState().edges.get(id) as GraphEdge;

describe('mapStore: building a network', () => {
  it('addNode creates unique ids that never clash with loaded ones', () => {
    const store = createMapStore(makeNetwork([['n0', 0, 0], ['n5', 1, 1]], []));
    const id = store.getState().addNode(10, 10);
    expect(id).toBe('n6');
    expect(store.getState().addNode(20, 20)).toBe('n7');
    expect(store.getState().nodes.get('n6')).toEqual({ id: 'n6', x: 10, y: 10, blocked: false });
  });

  it('addRoad uses the straight-line length and defaults to a free-flowing two-way road', () => {
    const store = sampleStore();
    const id = store.getState().addRoad('A', 'C') as string;
    expect(edge(store, id)).toMatchObject({ from: 'A', to: 'C', trafficLevel: 1, oneWay: false, closed: false });
    expect(edge(store, id).distance).toBeCloseTo(euclidean(0, 0, 13, 4), 9);
  });

  it('addRoad returns the existing road instead of duplicating, in either direction', () => {
    const store = sampleStore();
    expect(store.getState().addRoad('A', 'B')).toBe('r0');
    expect(store.getState().addRoad('B', 'A')).toBe('r0');
    expect(store.getState().edges.size).toBe(2);
  });

  it('addRoad rejects self-loops and unknown nodes', () => {
    const store = sampleStore();
    expect(store.getState().addRoad('A', 'A')).toBeNull();
    expect(store.getState().addRoad('A', 'Z')).toBeNull();
  });
});

describe('mapStore: moving nodes keeps distances valid', () => {
  it('a straight road stays exactly straight-line length', () => {
    const store = sampleStore();
    store.getState().moveNode('A', -3, -4); // A-B is now 10 long
    expect(edge(store, 'r0').distance).toBeCloseTo(10, 9);
  });

  it('a winding road keeps its winding ratio', () => {
    const store = sampleStore();
    store.getState().moveNode('C', 23, 4); // straight-line B-C doubles to 20
    expect(edge(store, 'r1').distance).toBeCloseTo(40, 9);
  });

  it('the network stays valid after arbitrary moves', () => {
    const store = sampleStore();
    store.getState().moveNode('B', 100, -50);
    store.getState().moveNode('A', 100, -50); // coincident with B
    store.getState().moveNode('C', -7, 3);
    expect(validateNetwork(selectNetwork(store.getState()))).toEqual([]);
  });

  it('moving bumps structureVersion', () => {
    const store = sampleStore();
    const before = store.getState().structureVersion;
    store.getState().moveNode('A', 1, 1);
    expect(store.getState().structureVersion).toBe(before + 1);
  });
});

describe('mapStore: editing distance', () => {
  it('accepts a distance at or above the straight-line length', () => {
    const store = sampleStore();
    expect(store.getState().setEdgeDistance('r0', 12)).toBe(12);
    expect(edge(store, 'r0').distance).toBe(12);
  });

  it('raises a distance below the straight-line length (A* admissibility)', () => {
    const store = sampleStore();
    expect(store.getState().setEdgeDistance('r0', 2)).toBe(5);
    expect(edge(store, 'r0').distance).toBe(5);
  });

  it('rejects zero, negative and non-numeric distances', () => {
    const store = sampleStore();
    for (const bad of [0, -1, NaN, Infinity]) expect(store.getState().setEdgeDistance('r0', bad)).toBeNull();
    expect(edge(store, 'r0').distance).toBe(5);
  });
});

describe('mapStore: road state', () => {
  it('cycleDirection goes two-way -> one-way -> reversed -> two-way', () => {
    const store = sampleStore();
    const cycle = () => {
      store.getState().cycleDirection('r0');
      const e = edge(store, 'r0');
      return e.oneWay ? `${e.from}->${e.to}` : 'two-way';
    };
    expect([cycle(), cycle(), cycle(), cycle()]).toEqual(['A->B', 'B->A', 'two-way', 'A->B']);
  });

  it('closing, traffic and obstacles are dynamic changes, not structural ones', () => {
    const store = sampleStore();
    const { version, structureVersion } = store.getState();
    store.getState().toggleClosed('r0');
    store.getState().setTraffic('r1', 4);
    store.getState().toggleBlocked('B');
    expect(edge(store, 'r0').closed).toBe(true);
    expect(edge(store, 'r1').trafficLevel).toBe(4);
    expect(store.getState().nodes.get('B')?.blocked).toBe(true);
    expect(store.getState().version).toBe(version + 3);
    expect(store.getState().structureVersion).toBe(structureVersion);
  });

  it('no-op updates do not bump the version', () => {
    const store = sampleStore();
    const { version } = store.getState();
    store.getState().setTraffic('r0', 1);
    store.getState().setClosed('r0', false);
    store.getState().setBlocked('A', false);
    expect(store.getState().version).toBe(version);
  });

  it('mutations replace the maps (copy-on-write) so subscribers see new identities', () => {
    const store = sampleStore();
    const before = store.getState().edges;
    store.getState().toggleClosed('r0');
    expect(store.getState().edges).not.toBe(before);
    expect(before.get('r0')?.closed).toBe(false); // old snapshot untouched
  });
});

describe('mapStore: deleting', () => {
  it('deleting a node removes its roads and clears references to it', () => {
    const store = sampleStore();
    store.getState().select({ kind: 'edge', id: 'r0' });
    store.getState().setPendingRoadFrom('A');
    store.getState().deleteNode('A');

    const s = store.getState();
    expect(s.nodes.has('A')).toBe(false);
    expect(s.edges.has('r0')).toBe(false);
    expect(s.edges.has('r1')).toBe(true);
    expect(s.start).toBeNull();
    expect(s.end).toBe('C');
    expect(s.selection).toBeNull();
    expect(s.pendingRoadFrom).toBeNull();
  });

  it('deleteSelection removes the selected road', () => {
    const store = sampleStore();
    store.getState().select({ kind: 'edge', id: 'r1' });
    store.getState().deleteSelection();
    expect(store.getState().edges.has('r1')).toBe(false);
    expect(store.getState().selection).toBeNull();
  });
});

describe('mapStore: loading', () => {
  it('loadNetwork replaces the map, keeps valid endpoints and requests a fit', () => {
    const store = sampleStore();
    const fit = store.getState().fitRequest;
    store.getState().loadNetwork(makeNetwork([['X', 0, 0], ['Y', 5, 0]], [{ from: 'X', to: 'Y' }]), { start: 'X', end: 'nope' });
    const s = store.getState();
    expect([...s.nodes.keys()]).toEqual(['X', 'Y']);
    expect(s.start).toBe('X');
    expect(s.end).toBeNull();
    expect(s.fitRequest).toBe(fit + 1);
  });

  it('selectNetwork is memoized while the map is unchanged', () => {
    const store = sampleStore();
    const a = selectNetwork(store.getState());
    expect(selectNetwork(store.getState())).toBe(a);
    store.getState().toggleClosed('r0');
    expect(selectNetwork(store.getState())).not.toBe(a);
  });

  it('setStart / setEnd ignore unknown ids', () => {
    const store = sampleStore();
    store.getState().setStart('nope');
    expect(store.getState().start).toBe('A');
    store.getState().setStart(null);
    expect(store.getState().start).toBeNull();
  });
});

describe('mapStore: reopen', () => {
  it('reopens roads and removes obstacles in a single change', () => {
    const store = sampleStore();
    store.getState().setClosed('r0', true);
    store.getState().setClosed('r1', true);
    store.getState().setBlocked('B', true);
    const { version, structureVersion } = store.getState();

    store.getState().reopen(['r0', 'r1', 'nope'], ['B']);
    const s = store.getState();
    expect([s.edges.get('r0')?.closed, s.edges.get('r1')?.closed, s.nodes.get('B')?.blocked]).toEqual([false, false, false]);
    expect(s.version).toBe(version + 1);
    expect(s.structureVersion).toBe(structureVersion);
  });

  it('is a no-op when nothing is closed or blocked', () => {
    const store = sampleStore();
    const { version } = store.getState();
    store.getState().reopen(['r0'], ['A']);
    expect(store.getState().version).toBe(version);
  });
});

describe('mapStore: stops (waypoints)', () => {
  it('toggles, reorders and removes stops without bumping the map version', () => {
    const store = sampleStore();
    const s = () => store.getState();
    const version = s().version;
    s().toggleWaypoint('B');
    s().toggleWaypoint('C');
    expect(s().waypoints).toEqual(['B', 'C']);
    s().moveWaypoint(1, -1);
    expect(s().waypoints).toEqual(['C', 'B']);
    s().moveWaypoint(0, -1); // out of range: ignored
    expect(s().waypoints).toEqual(['C', 'B']);
    s().toggleWaypoint('C'); // toggling an existing stop removes it
    expect(s().waypoints).toEqual(['B']);
    s().removeWaypoint(0);
    expect(s().waypoints).toEqual([]);
    s().toggleWaypoint('nope');
    expect(s().waypoints).toEqual([]);
    expect(s().version).toBe(version);
  });

  it('caps the number of stops', () => {
    const store = createMapStore(makeNetwork(Array.from({ length: 12 }, (_, i) => [`n${i}`, i, 0] as [string, number, number]), []));
    for (let i = 0; i < 12; i++) store.getState().toggleWaypoint(`n${i}`);
    expect(store.getState().waypoints).toHaveLength(MAX_WAYPOINTS);
  });

  it('deleting an intersection removes it from the stops', () => {
    const store = sampleStore();
    store.getState().toggleWaypoint('B');
    store.getState().deleteNode('B');
    expect(store.getState().waypoints).toEqual([]);
  });
});

describe('mapStore: turn restrictions', () => {
  const ban = { fromRoad: 'r0', via: 'B', toRoad: 'r1' };

  it('toggles a ban, bumping the version but not the structure version', () => {
    const store = sampleStore();
    const before = store.getState();
    store.getState().toggleTurnRestriction(ban);
    expect([...store.getState().turnRestrictions.values()]).toEqual([ban]);
    expect(store.getState().version).toBe(before.version + 1);
    expect(store.getState().structureVersion).toBe(before.structureVersion);
    store.getState().toggleTurnRestriction(ban);
    expect(store.getState().turnRestrictions.size).toBe(0);
  });

  it('rejects turns between roads that do not meet at the intersection', () => {
    const store = sampleStore();
    store.getState().toggleTurnRestriction({ fromRoad: 'r0', via: 'C', toRoad: 'r1' });
    store.getState().toggleTurnRestriction({ fromRoad: 'r0', via: 'B', toRoad: 'zz' });
    expect(store.getState().turnRestrictions.size).toBe(0);
  });

  it('deleting a road or the intersection drops its bans', () => {
    const store = sampleStore();
    store.getState().toggleTurnRestriction(ban);
    store.getState().deleteEdge('r1');
    expect(store.getState().turnRestrictions.size).toBe(0);
    const store2 = sampleStore();
    store2.getState().toggleTurnRestriction(ban);
    store2.getState().deleteNode('B');
    expect(store2.getState().turnRestrictions.size).toBe(0);
  });

  it('clears bans at one intersection or everywhere', () => {
    const store = sampleStore();
    store.getState().toggleTurnRestriction(ban);
    store.getState().toggleTurnRestriction({ fromRoad: 'r1', via: 'B', toRoad: 'r1' });
    store.getState().clearTurnRestrictions('A');
    expect(store.getState().turnRestrictions.size).toBe(2);
    store.getState().clearTurnRestrictions('B');
    expect(store.getState().turnRestrictions.size).toBe(0);
  });

  it('loadNetwork restores pins, stops and bans, dropping ones that do not fit the map', () => {
    const store = createMapStore();
    const net = makeNetwork([['A', 0, 0], ['B', 3, 4], ['C', 13, 4]], [{ from: 'A', to: 'B', id: 'r0' }, { from: 'B', to: 'C', id: 'r1' }]);
    store.getState().loadNetwork(net, { start: 'A', end: 'C', waypoints: ['B', 'X'], turnRestrictions: [ban, { fromRoad: 'r9', via: 'B', toRoad: 'r1' }] });
    const s = store.getState();
    expect([s.start, s.end, s.waypoints]).toEqual(['A', 'C', ['B']]);
    expect([...s.turnRestrictions.values()]).toEqual([ban]);
  });
});

describe('mapStore: traffic presets', () => {
  it('applies a preset in a single non-structural change and reports what changed', () => {
    const store = sampleStore();
    const before = store.getState();
    const changed = store.getState().applyTrafficPreset('rush');
    const after = store.getState();
    const differing = [...after.edges.values()].filter((e) => before.edges.get(e.id)?.trafficLevel !== e.trafficLevel).length;
    expect(changed).toBe(differing);
    expect(after.version).toBe(changed > 0 ? before.version + 1 : before.version);
    expect(after.structureVersion).toBe(before.structureVersion);
    // Applying the same preset again changes nothing.
    expect(store.getState().applyTrafficPreset('rush')).toBe(0);
  });
});
