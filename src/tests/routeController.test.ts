import { afterEach, describe, expect, it } from 'vitest';
import { dijkstra } from '../core/dijkstra';
import { compileGraph } from '../core/graph';
import { createMapStore, selectNetwork } from '../state/mapStore';
import { createRouteController, type RouteController } from '../state/routeController';
import { createRouteStore } from '../state/routeStore';
import { createInProcessTransport, type InProcessOptions } from '../worker/transport';
import { gridNetwork, makeNetwork } from './helpers';

/*
 *   A --10-- B --10-- C        A-B-C = 20 (optimal)
 *    \               /         A-D-C = 30
 *     15           15
 *       \         /
 *        -- D ---
 */
const sampleNetwork = () =>
  makeNetwork(
    [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 10, 10]],
    [
      { from: 'A', to: 'B', id: 'ab', distance: 10 },
      { from: 'B', to: 'C', id: 'bc', distance: 10 },
      { from: 'A', to: 'D', id: 'ad', distance: 15 },
      { from: 'D', to: 'C', id: 'dc', distance: 15 },
    ],
  );

const controllers: RouteController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
});

function setup(opts: { network?: ReturnType<typeof sampleNetwork>; start?: string | null; end?: string | null; transport?: InProcessOptions; slowMs?: number } = {}) {
  const map = createMapStore(opts.network ?? sampleNetwork(), { start: opts.start === undefined ? 'A' : opts.start, end: opts.end === undefined ? 'C' : opts.end });
  const route = createRouteStore();
  const transport = createInProcessTransport(opts.transport);
  const controller = createRouteController(map, route, transport, { debounceMs: 10, maxWaitMs: 60, slowMs: opts.slowMs ?? 1000, compareDelayMs: 5, compareRepeats: 1 });
  controllers.push(controller);
  const count = (type: string) => transport.sent.filter((m) => m.type === type).length;
  return { map, route, transport, controller, count };
}

async function computed(setupResult: ReturnType<typeof setup>) {
  setupResult.controller.compute('manual');
  await setupResult.controller.whenIdle();
  return setupResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('route controller (worker-backed)', () => {
  it('computes a route in the engine', async () => {
    const { route } = await computed(setup());
    const r = route.getState();
    expect(r.status).toBe('done');
    expect(r.result?.path).toEqual(['A', 'B', 'C']);
    expect(r.result?.cost).toBe(20);
    expect(r.resultFor).toMatchObject({ start: 'A', end: 'C', algorithm: 'dijkstra' });
  });

  it('clears the result when an endpoint is missing', async () => {
    const { map, route } = await computed(setup());
    map.getState().setEnd(null);
    expect(route.getState()).toMatchObject({ result: null, status: 'idle' });
  });

  it('recomputes immediately when an endpoint changes, and replays the animation', async () => {
    const { map, route, controller } = await computed(setup());
    const token = route.getState().animationToken;
    map.getState().setEnd('D');
    await controller.whenIdle();
    expect(route.getState().result?.path).toEqual(['A', 'D']);
    expect(route.getState().animationToken).toBe(token + 1);
  });

  it('reroutes on map edits without replaying the animation', async () => {
    const { map, route, controller } = await computed(setup());
    const token = route.getState().animationToken;

    map.getState().setClosed('bc', true); // closure on the active route
    await controller.whenIdle();
    expect(route.getState().result?.path).toEqual(['A', 'D', 'C']);
    expect(route.getState().result?.cost).toBe(30);

    map.getState().setClosed('bc', false); // reopening restores the better route
    await controller.whenIdle();
    expect(route.getState().result?.path).toEqual(['A', 'B', 'C']);

    map.getState().setTraffic('ab', 4); // A-B-C = 40 + 10 = 50 > 30
    await controller.whenIdle();
    expect(route.getState().result?.path).toEqual(['A', 'D', 'C']);

    expect(route.getState().animationToken).toBe(token);
    expect(route.getState().resultFor?.version).toBe(map.getState().version);
  });

  it('reports "no route" when the destination is cut off', async () => {
    const { map, route, controller } = await computed(setup());
    map.getState().setClosed('bc', true);
    map.getState().setClosed('dc', true);
    await controller.whenIdle();
    expect(route.getState().result?.found).toBe(false);
    expect(route.getState().status).toBe('done');
  });

  it('handles start == end', async () => {
    const { route } = await computed(setup({ start: 'B', end: 'B' }));
    expect(route.getState().result).toMatchObject({ found: true, path: ['B'], cost: 0 });
  });

  it('does not follow map edits while auto-update is off, and catches up when re-enabled', async () => {
    const { map, route, controller } = await computed(setup());
    route.getState().toggleAutoRoute();
    map.getState().setClosed('bc', true);
    await sleep(30);
    expect(route.getState().result?.path).toEqual(['A', 'B', 'C']); // stale on purpose

    route.getState().toggleAutoRoute();
    await controller.whenIdle();
    expect(route.getState().result?.path).toEqual(['A', 'D', 'C']);
  });

  it('recomputes when switching to A* or changing its heuristic', async () => {
    const { route, controller } = await computed(setup());
    const token = route.getState().animationToken;
    route.getState().setAlgorithm('astar');
    await controller.whenIdle();
    expect(route.getState().resultFor).toMatchObject({ algorithm: 'astar', heuristic: 'euclidean' });
    route.getState().setHeuristic('manhattan');
    await controller.whenIdle();
    expect(route.getState().resultFor?.heuristic).toBe('manhattan');
    expect(route.getState().animationToken).toBe(token + 2);
  });

  it('switching to bidirectional search gives the same route, with both search sides recorded', async () => {
    const { route, controller } = await computed(setup());
    route.getState().setAlgorithm('bidirectional');
    await controller.whenIdle();
    const r = route.getState();
    expect(r.resultFor?.algorithm).toBe('bidirectional');
    expect(r.result).toMatchObject({ path: ['A', 'B', 'C'], cost: 20 });
    // Survived the worker boundary (structured clone) as a typed array.
    expect(r.result?.exploredSides).toBeInstanceOf(Uint8Array);
    expect(r.result?.exploredSides?.length).toBe(r.result?.exploredInOrder.length);
  });
});

describe('route controller: skipping unnecessary work', () => {
  it('closing a road that is not on the route sends no request', async () => {
    const s = await computed(setup());
    const before = s.count('findRoute');
    s.map.getState().setClosed('ad', true); // off-route
    await s.controller.whenIdle();
    expect(s.count('findRoute')).toBe(before);
    expect(s.route.getState().resultFor?.version).toBe(s.map.getState().version);
    expect(s.route.getState().result?.path).toEqual(['A', 'B', 'C']);
  });

  it('worse traffic off the route is skipped; better traffic off the route is not', async () => {
    const s = await computed(setup());
    s.map.getState().setTraffic('dc', 4); // worse, off-route
    await s.controller.whenIdle();
    const afterWorse = s.count('findRoute');
    s.map.getState().setTraffic('dc', 2); // better: a cheaper alternative might now exist
    await s.controller.whenIdle();
    expect(s.count('findRoute')).toBe(afterWorse + 1);
  });

  it('reopening a road always recomputes', async () => {
    const s = await computed(setup());
    s.map.getState().setClosed('ad', true); // skipped
    await s.controller.whenIdle();
    const before = s.count('findRoute');
    s.map.getState().setClosed('ad', false);
    await s.controller.whenIdle();
    expect(s.count('findRoute')).toBe(before + 1);
  });

  it('skipped edits still reach the worker with the next request', async () => {
    const s = await computed(setup());
    s.map.getState().setClosed('ad', true); // skipped, not yet sent
    s.map.getState().setClosed('bc', true); // on route: recompute; both deltas sent now
    await s.controller.whenIdle();
    expect(s.route.getState().result?.found).toBe(false); // A-B-C and A-D-C both cut
    expect(s.transport.sent.filter((m) => m.type === 'applyDelta')).toHaveLength(2);
  });
});

describe('route controller: bursts, sync and stale responses', () => {
  it('a burst of 10 closures yields exactly one request and one correct final route', async () => {
    const network = gridNetwork(8, 8, 10);
    const s = await computed(setup({ network, start: 'g0_0', end: 'g7_7' }));
    const findsBefore = s.count('findRoute');
    const loadsBefore = s.count('loadGraph');

    // Ten closures in one synchronous burst, starting with roads on the current route.
    const onRoute = s.route.getState().result?.pathRoads ?? [];
    const toClose = [...onRoute.slice(0, 5), 'h3_3', 'v3_3', 'h4_4', 'v4_4', 'h2_5'];
    expect(new Set(toClose).size).toBe(10);
    for (const id of toClose) s.map.getState().setClosed(id, true);
    await s.controller.whenIdle();

    expect(s.count('findRoute')).toBe(findsBefore + 1);
    expect(s.count('loadGraph')).toBe(loadsBefore); // deltas only, no reload
    expect(s.transport.sent.filter((m) => m.type === 'applyDelta')).toHaveLength(10);

    const expected = dijkstra(compileGraph(selectNetwork(s.map.getState())), 'g0_0', 'g7_7');
    expect(s.route.getState().result?.cost).toBe(expected.cost);
    expect(s.route.getState().result?.pathRoads.some((id) => toClose.includes(id))).toBe(false);
  });

  it('only shape changes reload the graph; closures and moves travel as deltas', async () => {
    const s = await computed(setup());
    expect(s.count('loadGraph')).toBe(1);
    s.map.getState().setClosed('bc', true);
    await s.controller.whenIdle();
    expect(s.count('loadGraph')).toBe(1);
    s.map.getState().moveNode('D', 10, 20);
    await s.controller.whenIdle();
    expect(s.count('loadGraph')).toBe(1); // a move keeps the graph's shape: sent as deltas
    expect(s.transport.sent.some((m) => m.type === 'applyDelta' && m.delta.op === 'moveNode')).toBe(true);
    expect(s.route.getState().result?.path).toEqual(['A', 'D', 'C']);
    expect(s.route.getState().result?.cost).toBeCloseTo(dijkstra(compileGraph(selectNetwork(s.map.getState())), 'A', 'C').cost, 9);

    s.map.getState().addRoad('B', 'D'); // a new road changes the shape: full reload
    await s.controller.whenIdle();
    expect(s.count('loadGraph')).toBe(2);
  });

  it('an endpoint change during a pending request discards the older response', async () => {
    const s = setup({ transport: { latencyMs: 15 } });
    s.controller.compute('manual'); // request 1 (A -> C)
    s.map.getState().setEnd('D'); // request 2 supersedes it
    await s.controller.whenIdle();
    expect(s.route.getState().result?.path).toEqual(['A', 'D']);
    expect(s.controller.client.stats.staleDropped + s.transport.engine.stats.cancelled).toBeGreaterThanOrEqual(1);
  });

  it('sets `slow` while a request takes longer than slowMs, then clears it', async () => {
    const s = setup({ transport: { latencyMs: 40 }, slowMs: 20 });
    s.controller.compute('manual');
    expect(s.route.getState()).toMatchObject({ status: 'computing', slow: false });
    await sleep(45);
    expect(s.route.getState().slow).toBe(true);
    await s.controller.whenIdle();
    expect(s.route.getState()).toMatchObject({ status: 'done', slow: false });
  });

  it('stops listening after dispose', async () => {
    const s = await computed(setup());
    s.controller.dispose();
    s.map.getState().setEnd('D');
    await sleep(20);
    expect(s.route.getState().result?.path).toEqual(['A', 'B', 'C']);
  });
});

describe('route controller: algorithm comparison', () => {
  const comparisonDone = async (route: ReturnType<typeof setup>['route'], minLength = 1) => {
    for (let i = 0; i < 500; i++) {
      const c = route.getState().comparison;
      if (c?.status === 'done' && c.results.length >= minLength) return c;
      await sleep(2);
    }
    throw new Error('comparison did not finish');
  };

  it('auto mode compares every algorithm after the route settles; they agree', async () => {
    const s = await computed(setup());
    const c = await comparisonDone(s.route);
    expect(c.results.map((e) => [e.algorithm, e.cost])).toEqual([
      ['dijkstra', 20],
      ['astar', 20],
      ['bidirectional', 20],
      ['dstarlite', 20],
    ]);
    expect(c.for).toEqual({ start: 'A', end: 'C', version: s.map.getState().version });
  });

  it('manual mode: results go stale on edits and refresh on demand', async () => {
    const s = setup();
    s.route.getState().toggleCompareAuto(); // off
    s.controller.compute('manual');
    await s.controller.whenIdle();
    await sleep(20);
    expect(s.route.getState().comparison).toBeNull();

    s.controller.compareAll();
    const first = await comparisonDone(s.route);
    s.map.getState().setClosed('bc', true);
    await s.controller.whenIdle();
    await sleep(20);
    expect(s.route.getState().comparison?.for?.version).toBe(first.for?.version); // stale, not re-run

    s.controller.compareAll();
    await sleep(1);
    const refreshed = await comparisonDone(s.route);
    expect(refreshed.for?.version).toBe(s.map.getState().version);
    expect(refreshed.results.every((e) => e.cost === 30)).toBe(true);
  });

  it('toggling "Include A* (Manhattan)" re-runs with the extra row', async () => {
    const s = await computed(setup());
    await comparisonDone(s.route);
    s.route.getState().toggleCompareManhattan();
    const c = await comparisonDone(s.route, 5);
    expect(c.results.map((e) => e.heuristic)).toEqual([null, 'euclidean', 'manhattan', null, null]);
  });

  it('clearing an endpoint clears the comparison', async () => {
    const s = await computed(setup());
    await comparisonDone(s.route);
    s.map.getState().setEnd(null);
    expect(s.route.getState().comparison).toBeNull();
  });
});

describe('route controller: Phase 10', () => {
  it('re-routes through stops as they are added, reordered and removed', async () => {
    const s = await computed(setup());
    s.map.getState().toggleWaypoint('D');
    await s.controller.whenIdle();
    expect(s.route.getState().result).toMatchObject({ path: ['A', 'D', 'C'], cost: 30 });
    expect(s.route.getState().meta?.legs).toBe(2);
    expect(s.route.getState().resultFor?.waypoints).toEqual(['D']);

    s.map.getState().clearWaypoints();
    await s.controller.whenIdle();
    expect(s.route.getState().result?.path).toEqual(['A', 'B', 'C']);
    expect(s.route.getState().meta?.legs).toBe(1);
  });

  it('a turn restriction always recomputes (it is never "off the route")', async () => {
    const s = await computed(setup());
    s.map.getState().toggleTurnRestriction({ fromRoad: 'ab', via: 'B', toRoad: 'bc' });
    await sleep(20);
    await s.controller.whenIdle();
    expect(s.route.getState().result).toMatchObject({ path: ['A', 'D', 'C'], cost: 30 });
    expect(s.route.getState().meta?.turnRestricted).toBe(true);

    // A closure off the (new) route is still skipped.
    const sentBefore = s.count('findRoute');
    s.map.getState().setClosed('bc', true);
    await sleep(20);
    await s.controller.whenIdle();
    expect(s.count('findRoute')).toBe(sentBefore);
  });

  it('fetches alternatives when switched on, refreshes them after edits and clears them for waypoints', async () => {
    const s = await computed(setup());
    s.route.getState().toggleAlternatives();
    const done = async () => {
      for (let i = 0; i < 300; i++) {
        const a = s.route.getState().alternatives;
        if (a?.status === 'done' && a.for?.version === s.map.getState().version) return a;
        await sleep(2);
      }
      throw new Error('alternatives did not arrive');
    };
    expect((await done()).routes.map((r) => r.cost)).toEqual([20, 30]);

    s.map.getState().setTraffic('ab', 4); // A-B-C = 40 + 10 = 50, now dearer than A-D-C
    await s.controller.whenIdle();
    expect((await done()).routes.map((r) => r.cost)).toEqual([30, 50]);

    s.map.getState().toggleWaypoint('B');
    await s.controller.whenIdle();
    await sleep(20);
    expect(s.route.getState().alternatives).toBeNull();

    s.map.getState().clearWaypoints();
    await s.controller.whenIdle();
    await done();
    s.route.getState().toggleAlternatives(); // off
    expect(s.route.getState().alternatives).toBeNull();
  });

  it('D* Lite reports whether it repaired an earlier search', async () => {
    const s = setup();
    s.route.getState().setAlgorithm('dstarlite');
    await s.controller.whenIdle();
    expect(s.route.getState().meta?.reused).toBe(false);
    s.map.getState().setClosed('ab', true);
    await sleep(20);
    await s.controller.whenIdle();
    expect(s.route.getState().result?.path).toEqual(['A', 'D', 'C']);
    expect(s.route.getState().meta?.reused).toBe(true);
  });
});
