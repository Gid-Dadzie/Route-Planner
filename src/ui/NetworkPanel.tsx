/**
 * Network health (from the worker's DFS analysis): how many disconnected
 * regions the open road network has, and which intersections are isolated.
 * Isolated intersections are ringed in red on the map.
 */

import { useMapStore } from '../state/mapStore';
import { useRouteStore } from '../state/routeStore';
import { Panel } from './Panel';

export function NetworkPanel() {
  const network = useRouteStore((s) => s.network);
  const stale = useMapStore((s) => s.version) !== network?.version;

  if (!network) {
    return (
      <Panel id="network" title="Network">
        <p className="muted">Analysing…</p>
      </Panel>
    );
  }

  const { regions, largestRegion, isolated, blocked, usable } = network;
  const connected = regions <= 1;
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  return (
    <Panel id="network" title="Network" badge={stale && <span className="badge">Updating…</span>}>
      {usable === 0 ? (
        <p className="muted">No usable intersections.</p>
      ) : connected ? (
        <p>
          <span className="ok-dot" aria-hidden="true" /> All {plural(usable, 'usable intersection')} are connected.
        </p>
      ) : (
        <p className="note">
          {plural(regions, 'separate region')}: the largest has {largestRegion.toLocaleString()} of {usable.toLocaleString()} intersections. Routes can't cross between regions.
        </p>
      )}
      {isolated.length > 0 && (
        <p className="muted small">
          {plural(isolated.length, 'isolated intersection')} (ringed in red) {isolated.length === 1 ? 'has' : 'have'} no open road.
          {isolated.length <= 5 && ` ${isolated.join(', ')}.`}
        </p>
      )}
      {blocked > 0 && <p className="muted small">{plural(blocked, 'intersection')} blocked by obstacles.</p>}
      <p className="muted small">Direction is ignored here; one-way roads can still make a region one-way only.</p>
    </Panel>
  );
}
