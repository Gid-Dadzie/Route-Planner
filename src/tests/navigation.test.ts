import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../core/graph';
import { createMapStore } from '../state/mapStore';
import { boundsOf, centerOn, panBy, pinchStep, screenToWorld, zoomCentered, type Viewport } from '../ui/viewport';
import { findIntersections } from '../utils/findIntersections';
import {
  clampComparison,
  clampSidebar,
  COMPARISON_MIN,
  MAP_MIN_HEIGHT,
  MAP_MIN_WIDTH,
  RESIZE_STEP,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  stepComparison,
  stepSidebar,
} from '../ui/workspace';

const view = (): Viewport => ({ scale: 1, ox: 0, oy: 0, width: 800, height: 600 });
const worldToScreen = (v: Viewport, x: number, y: number) => ({ x: x * v.scale + v.ox, y: y * v.scale + v.oy });

describe('viewport navigation', () => {
  it('centerOn puts the point in the middle of the view at the requested scale (clamped)', () => {
    const v = view();
    centerOn(v, 100, 50, 2);
    expect(worldToScreen(v, 100, 50)).toEqual({ x: 400, y: 300 });
    expect(v.scale).toBe(2);
    centerOn(v, 0, 0, 1e9);
    expect(v.scale).toBe(20); // MAX_SCALE
  });

  it('zoomCentered keeps the centre fixed; panBy moves the view', () => {
    const v = view();
    const centre = screenToWorld(v, 400, 300);
    zoomCentered(v, 1.4);
    expect(worldToScreen(v, centre.x, centre.y).x).toBeCloseTo(400, 9);
    expect(worldToScreen(v, centre.x, centre.y).y).toBeCloseTo(300, 9);
    panBy(v, 10, -5);
    expect(worldToScreen(v, centre.x, centre.y).x).toBeCloseTo(410, 9);
    expect(worldToScreen(v, centre.x, centre.y).y).toBeCloseTo(295, 9);
  });

  it('pinch: the world point under the fingers stays under them', () => {
    const v = view();
    const a0 = { x: 300, y: 300 };
    const b0 = { x: 500, y: 300 };
    const grabbed = screenToWorld(v, 400, 300); // midpoint
    // Spread the fingers to twice the distance and move them 50px right.
    const a1 = { x: 250, y: 300 };
    const b1 = { x: 650, y: 300 };
    pinchStep(v, a0, b0, a1, b1);
    expect(v.scale).toBeCloseTo(2, 9);
    const now = worldToScreen(v, grabbed.x, grabbed.y);
    expect(now.x).toBeCloseTo(450, 9);
    expect(now.y).toBeCloseTo(300, 9);
  });

  it('pinch with fingers on one spot only pans', () => {
    const v = view();
    const p = { x: 100, y: 100 };
    pinchStep(v, p, p, { x: 120, y: 90 }, { x: 120, y: 90 });
    expect(v).toMatchObject({ scale: 1, ox: 20, oy: -10 });
  });

  it('boundsOf', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: 3, y: -1 }, { x: -2, y: 7 }])).toEqual({ minX: -2, minY: -1, maxX: 3, maxY: 7 });
  });
});

describe('findIntersections', () => {
  const nodes: GraphNode[] = [
    { id: 'n1', x: 0, y: 0, blocked: false },
    { id: 'n10', x: 0, y: 0, blocked: false, label: 'Market Square' },
    { id: 'n12', x: 0, y: 0, blocked: false },
    { id: 'n100', x: 0, y: 0, blocked: false },
    { id: 'x7', x: 0, y: 0, blocked: false, label: 'North Gate' },
    { id: 'n2', x: 0, y: 0, blocked: false, label: 'Old Market' },
  ];
  const ids = (q: string, limit?: number) => findIntersections(nodes, q, limit).map((f) => f.node.id);

  it('ranks exact id, then id prefix (shorter first), then labels', () => {
    expect(ids('n1')).toEqual(['n1', 'n10', 'n12', 'n100']);
    expect(ids('N10')).toEqual(['n10', 'n100']); // case-insensitive
  });

  it('matches labels by prefix before substring, and reports what matched', () => {
    expect(ids('market')).toEqual(['n10', 'n2']);
    expect(findIntersections(nodes, 'gate')[0]).toMatchObject({ matched: 'label', node: { id: 'x7' } });
  });

  it('empty query and limit', () => {
    expect(ids('   ')).toEqual([]);
    expect(ids('n', 2)).toEqual(['n1', 'n2']);
  });
});

describe('mapStore.requestFocus', () => {
  it('numbers each request so repeated focus on the same node still fires', () => {
    const store = createMapStore();
    store.getState().requestFocus({ type: 'node', id: 'a' });
    store.getState().requestFocus({ type: 'node', id: 'a' });
    expect(store.getState().focusRequest).toEqual({ seq: 2, target: { type: 'node', id: 'a' } });
    store.getState().requestFocus({ type: 'route' });
    expect(store.getState().focusRequest?.seq).toBe(3);
  });
});

describe('resizable workspace', () => {
  it('clamps the side panel between its minimum and leaving the map room', () => {
    expect(clampSidebar(100, 1400)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(500, 1400)).toBe(500);
    expect(clampSidebar(5000, 1400)).toBe(1400 - MAP_MIN_WIDTH);
    expect(clampSidebar(400, 300)).toBe(SIDEBAR_MIN); // tiny window: minimum wins
  });

  it('◀ widens, ▶ narrows, and ▶ at the minimum hides; ◀ restores the old width', () => {
    let s = { open: true, width: SIDEBAR_DEFAULT };
    s = stepSidebar(s, 'grow', 1400);
    expect(s).toEqual({ open: true, width: SIDEBAR_DEFAULT + RESIZE_STEP });
    s = stepSidebar(stepSidebar(s, 'shrink', 1400), 'shrink', 1400);
    expect(s).toEqual({ open: true, width: SIDEBAR_MIN });
    s = stepSidebar(s, 'shrink', 1400);
    expect(s).toEqual({ open: false, width: SIDEBAR_MIN });
    expect(stepSidebar(s, 'shrink', 1400)).toBe(s); // already hidden
    expect(stepSidebar(s, 'grow', 1400)).toEqual({ open: true, width: SIDEBAR_MIN });
  });

  it('▲ grows the comparison from its measured height, ▼ shrinks and folds it at the minimum', () => {
    let c: { open: boolean; height: number | null } = { open: true, height: null };
    c = stepComparison(c, 'grow', 260, 800);
    expect(c).toEqual({ open: true, height: 260 + RESIZE_STEP });
    c = stepComparison(c, 'grow', 0, 400); // cannot squeeze the map below its minimum
    expect(c.height).toBe(400 - MAP_MIN_HEIGHT);
    c = { open: true, height: COMPARISON_MIN + 20 };
    c = stepComparison(c, 'shrink', 0, 800);
    expect(c).toEqual({ open: true, height: COMPARISON_MIN });
    c = stepComparison(c, 'shrink', 0, 800);
    expect(c).toEqual({ open: false, height: COMPARISON_MIN });
    expect(stepComparison(c, 'grow', 0, 800)).toEqual({ open: true, height: COMPARISON_MIN });
    expect(clampComparison(50, 800)).toBe(COMPARISON_MIN);
  });
});
