/**
 * Time-of-day traffic presets: set every road's traffic level at once.
 *
 * Congestion is modelled as a score per road:
 *   score = centrality weight x how central the road is (1 at the map's centre, 0 at its edge)
 *         + noise weight x a stable per-road random value (hash of the road id).
 * The score is cut into levels 1-4 at the preset's thresholds. Rush hour
 * weights the centre heavily, so the core jams and the ring roads stay
 * usable; night is almost all free flow.
 *
 * The noise is a hash of the road id, not a random draw, so applying a preset
 * twice gives the same map, and switching presets back and forth is stable.
 */

import type { GraphEdge, GraphNode, TrafficLevel } from '../core/graph';

export type TrafficPresetId = 'night' | 'midday' | 'rush';

interface PresetModel {
  centrality: number;
  noise: number;
  /** Score thresholds for levels 2, 3 and 4. */
  thresholds: readonly [number, number, number];
}

export const TRAFFIC_PRESETS: ReadonlyArray<{ id: TrafficPresetId; label: string; description: string }> = [
  { id: 'night', label: 'Night', description: 'Almost every road free-flowing.' },
  { id: 'midday', label: 'Midday', description: 'Moderate traffic, a little heavier toward the centre.' },
  { id: 'rush', label: 'Rush hour', description: 'Heavy congestion in the centre; outer roads stay usable.' },
];

const MODELS: Record<TrafficPresetId, PresetModel> = {
  night: { centrality: 0.1, noise: 0.3, thresholds: [0.34, 0.39, 0.5] },
  midday: { centrality: 0.45, noise: 0.55, thresholds: [0.45, 0.7, 0.88] },
  rush: { centrality: 0.75, noise: 0.45, thresholds: [0.32, 0.55, 0.78] },
};

/** FNV-1a hash of a string, scaled to [0, 1). */
export function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** The traffic level the preset assigns to every road (roads with missing endpoints are skipped). */
export function presetTraffic(
  preset: TrafficPresetId,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge>,
): Map<string, TrafficLevel> {
  const model = MODELS[preset];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY) / 2);

  const levels = new Map<string, TrafficLevel>();
  for (const e of edges.values()) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const centrality = 1 - Math.min(1, Math.hypot(mx - cx, my - cy) / radius);
    const score = model.centrality * centrality + model.noise * hash01(e.id);
    const [t2, t3, t4] = model.thresholds;
    levels.set(e.id, score >= t4 ? 4 : score >= t3 ? 3 : score >= t2 ? 2 : 1);
  }
  return levels;
}
