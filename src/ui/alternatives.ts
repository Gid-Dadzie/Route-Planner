/**
 * Which alternative routes to draw, and how they relate to the main route.
 * Pure functions of store state, shared by the canvas, the route panel and
 * the image export.
 */

import type { MapState } from '../state/mapStore';
import type { RouteState } from '../state/routeStore';
import type { AlternativeRoute } from '../worker/protocol';
import { ALTERNATIVE_COLORS, type AlternativeLayer } from './renderMap';

/**
 * The alternatives that describe the current map and pins, or null when
 * they are switched off, not applicable (waypoints) or out of date.
 */
export function currentAlternatives(
  map: Pick<MapState, 'start' | 'end' | 'version' | 'waypoints'>,
  route: Pick<RouteState, 'alternatives' | 'showAlternatives'>,
): AlternativeRoute[] | null {
  const alt = route.alternatives;
  if (!route.showAlternatives || !alt?.for || map.waypoints.length > 0) return null;
  if (alt.for.start !== map.start || alt.for.end !== map.end || alt.for.version !== map.version) return null;
  return alt.routes;
}

/** Map layers for the alternatives (the first route is the main one and is drawn separately). */
export function alternativeLayers(
  map: Pick<MapState, 'start' | 'end' | 'version' | 'waypoints'>,
  route: Pick<RouteState, 'alternatives' | 'showAlternatives'>,
): AlternativeLayer[] {
  const routes = currentAlternatives(map, route);
  if (!routes) return [];
  return routes.slice(1).map((r, i) => ({ path: r.path, color: alternativeColor(i) }));
}

/** Colour of the i-th alternative (0 = second-cheapest route). */
export function alternativeColor(i: number): string {
  return ALTERNATIVE_COLORS[i % ALTERNATIVE_COLORS.length] as string;
}

/** Share of `route`'s distance that runs on roads the main route also uses (0..1). */
export function sharedDistance(route: AlternativeRoute, main: AlternativeRoute, edges: MapState['edges']): number {
  if (route.distance <= 0) return 1;
  const mainRoads = new Set(main.pathRoads);
  let shared = 0;
  for (const id of route.pathRoads) if (mainRoads.has(id)) shared += edges.get(id)?.distance ?? 0;
  return Math.min(1, shared / route.distance);
}
