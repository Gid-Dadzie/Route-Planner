/**
 * The manual test scenarios from the project document (section 10.4), run end
 * to end: map store -> route controller -> client -> engine (in-process
 * transport with structured cloning) -> route store. Every final route is
 * cross-checked against Dijkstra run directly on the same map.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dijkstra } from '../core/dijkstra';
import { compileGraph, type TrafficLevel } from '../core/graph';
import { createMapStore, selectNetwork } from '../state/mapStore';
import { createRouteController, type RouteController } from '../state/routeController';
import { createRouteStore } from '../state/routeStore';
import { generateGridMap } from '../utils/mapGenerator';
import { createInProcessTransport } from '../worker/transport';

const controllers: RouteController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
});

async function city() {
  const { network, start, end } = generateGridMap({ cols: 14, rows: 10, seed: 21, oneWayRate: 0.05 });
  const map = createMapStore(network, { start, end });
  const route = createRouteStore();
  const transport = createInProcessTransport();
  const controller = createRouteController(map, route, transport, { debounceMs: 5, maxWaitMs: 30, analysisDelayMs: 5 });
  controllers.push(controller);
  controller.compute('manual');
  await controller.whenIdle();

  const settle = () => controller.whenIdle();
  const reference = () => {
    const s = map.getState();
    return dijkstra(compileGraph(selectNetwork(s)), s.start as string, s.end as string);
  };
  const current = () => route.getState().result!;
  return { map, route, transport, controller, settle, reference, current, start, end };
}

describe('scenario 1: close a road on the active route', () => {
  it('detours automatically to the next-best route', async () => {
    const c = await city();
    const before = c.current();
    const victim = before.pathRoads[Math.floor(before.pathRoads.length / 2)] as string;

    c.map.getState().setClosed(victim, true);
    await c.settle();

    const after = c.current();
    expect(after.found).toBe(true);
    expect(after.pathRoads).not.toContain(victim);
    expect(after.cost).toBeGreaterThanOrEqual(before.cost);
    expect(after.cost).toBeCloseTo(c.reference().cost, 9);
  });
});

describe('scenario 2: close every road leading to the destination', () => {
  it('reports "No route available" instantly, highlights the destination and its closed roads', async () => {
    const c = await city();
    const incident = [...c.map.getState().edges.values()].filter((e) => e.from === c.end || e.to === c.end).map((e) => e.id);
    expect(incident.length).toBeGreaterThan(0);

    for (const id of incident) c.map.getState().setClosed(id, true);
    await c.settle();

    const r = c.route.getState();
    expect(r.result?.found).toBe(false);
    expect(r.method).toBe('reachability'); // the weighted search was skipped
    expect(r.noRoute).toMatchObject({ reason: 'unreachable', side: 'end', region: [c.end] });
    expect([...(r.noRoute?.closedRoads ?? [])].sort()).toEqual([...incident].sort());
    expect(c.transport.engine.stats.reachabilityShortcuts).toBeGreaterThanOrEqual(1);

    // "Reopen" brings the original route back.
    c.map.getState().reopen(r.noRoute!.closedRoads, r.noRoute!.blockedNodes);
    await c.settle();
    expect(c.current().found).toBe(true);
    expect(c.current().cost).toBeCloseTo(c.reference().cost, 9);
  });

  it('blocking the destination is reported as a blocked endpoint', async () => {
    const c = await city();
    c.map.getState().setBlocked(c.end, true);
    await c.settle();
    expect(c.route.getState().noRoute).toMatchObject({ reason: 'blocked-end', blockedNodes: [c.end] });
  });
});

describe('scenario 3: raise traffic on the shortest route until another becomes cheaper', () => {
  it('switches to the alternative exactly when it becomes cheaper', async () => {
    const c = await city();
    const original = c.current();
    const roads = original.pathRoads;

    let switched = false;
    for (let level = 2; level <= 4 && !switched; level++) {
      for (const id of roads) c.map.getState().setTraffic(id, level as TrafficLevel);
      await c.settle();
      const now = c.current();
      // Whatever was chosen must be optimal for the current traffic.
      expect(now.cost).toBeCloseTo(c.reference().cost, 9);
      switched = now.pathRoads.join() !== roads.join();
    }
    expect(switched).toBe(true);

    // The new route is cheaper than the old path at the raised traffic levels.
    const s = c.map.getState();
    const oldPathCost = roads.reduce((sum, id) => {
      const e = s.edges.get(id)!;
      return sum + e.distance * [0, 1, 1.5, 2.5, 4][e.trafficLevel]!;
    }, 0);
    expect(c.current().cost).toBeLessThan(oldPathCost);
  });
});

describe('scenario 4: reopen a road', () => {
  it('the route improves again', async () => {
    const c = await city();
    const best = c.current();
    const victim = best.pathRoads[0] as string;

    c.map.getState().setClosed(victim, true);
    await c.settle();
    const detour = c.current();
    expect(detour.cost).toBeGreaterThan(best.cost);

    c.map.getState().setClosed(victim, false);
    await c.settle();
    expect(c.current().cost).toBeCloseTo(best.cost, 9);
    expect(c.current().pathRoads).toContain(victim);
  });
});

describe('network health analysis', () => {
  it('reports one region, then splits when a corner is walled off', async () => {
    const c = await city();
    const waitForNetwork = async (version: number) => {
      while (c.route.getState().network?.version !== version) await new Promise((r) => setTimeout(r, 2));
    };
    await waitForNetwork(c.map.getState().version);
    expect(c.route.getState().network).toMatchObject({ regions: 1, isolated: [] });

    // Isolate the start corner by closing all its roads.
    const incident = [...c.map.getState().edges.values()].filter((e) => e.from === c.start || e.to === c.start);
    for (const e of incident) c.map.getState().setClosed(e.id, true);
    await waitForNetwork(c.map.getState().version);
    expect(c.route.getState().network).toMatchObject({ regions: 2, isolated: [c.start] });
  });
});
