/**
 * Export the route as a PNG. The map is re-rendered off-screen at a fixed
 * size, framed on the route (or the whole map when there is none), with the
 * finished route, alternatives and pins, plus a caption with the route's
 * numbers. Nothing on screen changes.
 */

import { getHeuristic } from '../core/heuristics';
import { getAlgorithm } from '../core/algorithms';
import type { GraphNode } from '../core/graph';
import { mapStore } from '../state/mapStore';
import { routeStore } from '../state/routeStore';
import { alternativeLayers } from './alternatives';
import { downloadBlob } from './mapFiles';
import { CANVAS_COLORS, renderMap, type RouteLayer } from './renderMap';
import { finalFrame } from './routeAnimation';
import { fitBounds, type Viewport } from './viewport';

const WIDTH = 1600;
const HEIGHT = 1000;
/** Device pixel ratio of the export: 2 gives a crisp 3200 x 2000 image. */
const SCALE = 2;

/** Renders the export. Exposed separately from the download for testing in a browser. */
export function renderRouteImage(): HTMLCanvasElement {
  const s = mapStore.getState();
  const r = routeStore.getState();

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * SCALE;
  canvas.height = HEIGHT * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available.');

  // Frame the route and stops, or the whole map.
  const focus: GraphNode[] = [];
  const result = r.result?.found ? r.result : null;
  for (const id of [...(result?.path ?? []), ...s.waypoints, s.start ?? '', s.end ?? '']) {
    const n = s.nodes.get(id);
    if (n) focus.push(n);
  }
  const framed = focus.length >= 2 ? focus : [...s.nodes.values()];
  const v: Viewport = { scale: 1, ox: 0, oy: 0, width: WIDTH, height: HEIGHT };
  if (framed.length > 0) {
    const xs = framed.map((n) => n.x);
    const ys = framed.map((n) => n.y);
    // Bottom padding leaves room for the caption.
    fitBounds(v, { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, 90);
  }

  const route: RouteLayer | null = r.result
    ? {
        path: r.result.path,
        explored: r.result.exploredInOrder,
        ...(r.result.exploredSides ? { exploredSides: r.result.exploredSides } : {}),
        ...finalFrame(r.result.exploredInOrder.length),
        showExplored: r.showExplored,
        faded: false,
        cutOff: r.noRoute,
      }
    : null;

  renderMap(
    ctx,
    v,
    SCALE,
    { ...s, selection: null, pendingRoadFrom: null },
    { hover: null, cursor: null, drag: null, isolated: [], route, alternatives: alternativeLayers(s, r) },
  );

  drawCaption(ctx, captionLines());
  return canvas;
}

/** Renders the export and downloads it. */
export async function exportRouteImage(): Promise<void> {
  const canvas = renderRouteImage();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode the image.');
  downloadBlob(blob, `route-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`);
}

function captionLines(): string[] {
  const s = mapStore.getState();
  const r = routeStore.getState();
  const name = (id: string | null) => {
    const n = id ? s.nodes.get(id) : undefined;
    return n ? (n.label ? `${n.label} (${n.id})` : n.id) : '—';
  };
  const via = s.waypoints.length ? ` via ${s.waypoints.map(name).join(', ')}` : '';
  const title = `Route ${name(s.start)} → ${name(s.end)}${via}`;
  const result = r.result;
  if (!s.start || !s.end || !result) return [title, 'No route computed.'];
  if (!result.found) return [title, 'No route available.'];

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const algo = r.resultFor ? getAlgorithm(r.resultFor.algorithm).label + (r.resultFor.algorithm === 'astar' ? ` (${getHeuristic(r.resultFor.heuristic).label})` : '') : '';
  return [
    title,
    `Cost ${fmt(result.cost)} · distance ${fmt(result.distance)} · ${result.path.length.toLocaleString()} intersections · ${result.nodesExplored.toLocaleString()} explored · ${algo}`,
  ];
}

function drawCaption(ctx: CanvasRenderingContext2D, lines: string[]): void {
  ctx.save();
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  const pad = 14;
  const lineH = 22;
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  const widths = lines.map((line, i) => {
    ctx.font = i === 0 ? '600 16px ui-sans-serif, system-ui, sans-serif' : '14px ui-sans-serif, system-ui, sans-serif';
    return ctx.measureText(line).width;
  });
  const w = Math.min(WIDTH - 32, Math.max(...widths) + pad * 2);
  const h = lines.length * lineH + pad * 2 - 6;
  const x = 16;
  const y = HEIGHT - 16 - h;
  ctx.fillStyle = 'rgba(17, 26, 46, 0.92)';
  ctx.strokeStyle = '#23314f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.font = i === 0 ? '600 16px ui-sans-serif, system-ui, sans-serif' : '14px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = i === 0 ? CANVAS_COLORS.node : '#8b9ab5';
    ctx.fillText(line, x + pad, y + pad + i * lineH, w - pad * 2);
  });
  ctx.restore();
}
