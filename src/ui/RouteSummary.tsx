/**
 * Route summary panel: algorithm choice, endpoints and stops, the route's
 * metrics, alternative routes and display options. Shows explicit states for
 * missing pins, identical pins, blocked endpoints, "no route" and errors.
 */

import { ALGORITHMS } from '../core/algorithms';
import type { SearchResult } from '../core/graph';
import type { NoRouteInfo } from '../worker/protocol';
import { getHeuristic, HEURISTICS } from '../core/heuristics';
import { routeController } from '../state/appRoute';
import { MAX_WAYPOINTS, mapStore, useMapStore } from '../state/mapStore';
import { routeStore, useRouteStore, type RouteMeta } from '../state/routeStore';
import { alternativeColor, currentAlternatives, sharedDistance } from './alternatives';
import { ROUTE_COLORS } from './renderMap';

export function RouteSummary() {
  const start = useMapStore((s) => s.start);
  const end = useMapStore((s) => s.end);
  const startNode = useMapStore((s) => (s.start ? s.nodes.get(s.start) : undefined));
  const endNode = useMapStore((s) => (s.end ? s.nodes.get(s.end) : undefined));

  const algorithm = useRouteStore((s) => s.algorithm);
  const result = useRouteStore((s) => s.result);
  const heuristic = useRouteStore((s) => s.heuristic);
  const resultAlgorithm = useRouteStore((s) => s.resultFor?.algorithm);
  const resultHeuristic = useRouteStore((s) => s.resultFor?.heuristic);
  const status = useRouteStore((s) => s.status);
  const slow = useRouteStore((s) => s.slow);
  const noRoute = useRouteStore((s) => s.noRoute);
  const method = useRouteStore((s) => s.method);
  const error = useRouteStore((s) => s.error);
  const showExplored = useRouteStore((s) => s.showExplored);
  const animate = useRouteStore((s) => s.animate);
  const autoRoute = useRouteStore((s) => s.autoRoute);
  const meta = useRouteStore((s) => s.meta);
  const turnCount = useMapStore((s) => s.turnRestrictions.size);
  const r = routeStore.getState();

  const name = (id: string, label?: string) => (label ? `${label} (${id})` : id);
  const resultLabel =
    (ALGORITHMS.find((a) => a.id === resultAlgorithm)?.label ?? '') +
    (resultAlgorithm === 'astar' && resultHeuristic ? ` · ${getHeuristic(resultHeuristic).label}` : '');

  return (
    <section className="panel">
      <h2>
        Route{slow && <span className="badge">Recalculating…</span>}
      </h2>

      <div className="segmented" role="radiogroup" aria-label="Algorithm">
        {ALGORITHMS.map((a) => (
          <button
            key={a.id}
            role="radio"
            aria-checked={algorithm === a.id}
            className={algorithm === a.id ? 'active' : ''}
            disabled={!a.search}
            title={a.search ? a.description : `${a.description} (coming in a later phase)`}
            onClick={() => r.setAlgorithm(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>

      {algorithm === 'astar' && (
        <div className="field heuristic">
          <span>Heuristic</span>
          <div className="segmented" role="radiogroup" aria-label="A* heuristic">
            {HEURISTICS.map((h) => (
              <button key={h.id} role="radio" aria-checked={heuristic === h.id} className={heuristic === h.id ? 'active' : ''} title={h.description} onClick={() => r.setHeuristic(h.id)}>
                {h.label}
              </button>
            ))}
          </div>
          {!getHeuristic(heuristic).admissible && <p className="note small">{getHeuristic(heuristic).description}</p>}
        </div>
      )}

      <dl className="endpoints">
        <dt>
          <span className="pin start">A</span> Start
        </dt>
        <dd>{startNode ? name(startNode.id, startNode.label) : <span className="muted">not set</span>}</dd>
        <dt>
          <span className="pin end">B</span> End
        </dt>
        <dd>{endNode ? name(endNode.id, endNode.label) : <span className="muted">not set</span>}</dd>
      </dl>
      <Waypoints />

      <RouteStatus
        start={start}
        end={end}
        startBlocked={startNode?.blocked ?? false}
        endBlocked={endNode?.blocked ?? false}
        status={status}
        error={error}
        result={result}
        algorithmLabel={resultLabel}
        noRoute={noRoute}
        method={method}
        meta={meta}
      />

      {result && <RouteNotes meta={meta} result={result} turnCount={turnCount} />}

      {resultAlgorithm === 'bidirectional' && result && showExplored && (
        <p className="explored-legend small">
          Explored: <span className="swatch" style={{ background: ROUTE_COLORS.frontier }} /> forward from A{' '}
          <span className="swatch" style={{ background: ROUTE_COLORS.frontierBackward }} /> backward from B
        </p>
      )}
      {resultAlgorithm === 'dstarlite' && result && showExplored && (
        <p className="explored-legend small">
          Explored: <span className="swatch" style={{ background: ROUTE_COLORS.frontierBackward }} /> backward from B
        </p>
      )}

      <Alternatives />

      <div className="options">
        <label>
          <input type="checkbox" checked={showExplored} onChange={r.toggleExplored} /> Show explored
        </label>
        <label>
          <input type="checkbox" checked={animate} onChange={r.toggleAnimate} /> Animate
        </label>
        <label title="Recalculate automatically whenever the map changes">
          <input type="checkbox" checked={autoRoute} onChange={r.toggleAutoRoute} /> Auto-update
        </label>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => routeController.compute('manual')} disabled={!start || !end}>
          Recalculate
        </button>
        <button className="btn" onClick={r.replay} disabled={!result || !animate}>
          Replay
        </button>
      </div>
    </section>
  );
}

interface RouteStatusProps {
  start: string | null;
  end: string | null;
  startBlocked: boolean;
  endBlocked: boolean;
  status: 'idle' | 'computing' | 'done' | 'error';
  error: string | null;
  result: SearchResult | null;
  algorithmLabel: string;
  noRoute: NoRouteInfo | null;
  method: 'search' | 'reachability' | null;
  meta: RouteMeta | null;
}

function RouteStatus({ start, end, startBlocked, endBlocked, status, error, result, algorithmLabel, noRoute, method, meta }: RouteStatusProps) {
  if (!start && !end) return <p className="muted">Place a start pin (S) and a destination pin (E).</p>;
  if (!start) return <p className="muted">Place a start pin (S).</p>;
  if (!end) return <p className="muted">Place a destination pin (E).</p>;
  if (status === 'error') return <p className="note error">{error}</p>;
  if (!result) return <p className="muted">Calculating…</p>;

  if (!result.found) {
    return <NoRouteDetails info={noRoute} method={method} result={result} algorithmLabel={algorithmLabel} startBlocked={startBlocked} endBlocked={endBlocked} meta={meta} />;
  }

  return (
    <>
      {start === end && <p className="note">Start and destination are the same intersection.</p>}
      <dl className="metrics" role="status">
        <div>
          <dt>Total cost</dt>
          <dd>{formatNumber(result.cost)}</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{formatNumber(result.distance)}</dd>
        </div>
        <div>
          <dt>Intersections</dt>
          <dd>{result.path.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Nodes explored</dt>
          <dd>{result.nodesExplored.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{result.timeMs < 1 ? `${result.timeMs.toFixed(2)} ms` : `${result.timeMs.toFixed(1)} ms`}</dd>
        </div>
        <div>
          <dt>Algorithm</dt>
          <dd>{algorithmLabel}</dd>
        </div>
      </dl>
      {result.distance > 0 && result.cost > result.distance * 1.001 && (
        <p className="muted small">Traffic adds {formatNumber(result.cost - result.distance)} ({Math.round((result.cost / result.distance - 1) * 100)}%) to the distance.</p>
      )}
    </>
  );
}

/** Short notes about how the route was found: legs, turn restrictions, D* Lite reuse. */
function RouteNotes({ meta, result, turnCount }: { meta: RouteMeta | null; result: SearchResult; turnCount: number }) {
  if (!meta || !result.found) return null;
  const notes: string[] = [];
  if (meta.legs > 1) notes.push(`${meta.legs} legs, searched one after another; explored counts add up over the legs.`);
  if (meta.turnRestricted) notes.push(`Respects ${plural(turnCount, 'banned turn')} (searched on the road-to-road graph).`);
  if (meta.reused === true) {
    notes.push(
      result.nodesExplored === 0
        ? 'D* Lite reused its previous search: nothing affecting the route changed, so no intersection was re-expanded.'
        : `D* Lite repaired its previous search, re-expanding ${plural(result.nodesExplored, 'intersection')} (a change near the destination costs more to repair than one near the start).`,
    );
  } else if (meta.reused === false && !meta.turnRestricted) {
    notes.push('D* Lite built its search from scratch; later closures and traffic changes are repaired incrementally.');
  }
  if (notes.length === 0) return null;
  return (
    <ul className="route-notes muted small">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/** The ordered list of intermediate stops, with reorder and remove controls. */
function Waypoints() {
  const waypoints = useMapStore((s) => s.waypoints);
  const nodes = useMapStore((s) => s.nodes);
  const tool = useMapStore((s) => s.tool);
  const s = mapStore.getState();

  if (waypoints.length === 0) {
    return (
      <p className="muted small waypoint-hint">
        {tool === 'waypoint' ? 'Click intersections to add stops in visiting order.' : 'Add stops with the Stop tool (W).'}
      </p>
    );
  }
  return (
    <div className="waypoints">
      <ol>
        {waypoints.map((id, i) => {
          const n = nodes.get(id);
          return (
            <li key={`${id}-${i}`}>
              <span className="pin waypoint">{i + 1}</span>
              <span className="waypoint-name">{n?.label ? `${n.label} (${id})` : id}</span>
              <button className="icon-btn" title="Visit earlier" disabled={i === 0} onClick={() => s.moveWaypoint(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" title="Visit later" disabled={i === waypoints.length - 1} onClick={() => s.moveWaypoint(i, 1)}>
                ↓
              </button>
              <button className="icon-btn" title="Remove stop" onClick={() => s.removeWaypoint(i)}>
                ✕
              </button>
            </li>
          );
        })}
      </ol>
      <div className="waypoint-foot muted small">
        {waypoints.length} of {MAX_WAYPOINTS} stops ·{' '}
        <button className="link-btn" onClick={s.clearWaypoints}>
          Clear stops
        </button>
      </div>
    </div>
  );
}

/** Alternative routes (Yen's k-shortest paths): toggle, count and the list. */
function Alternatives() {
  const show = useRouteStore((s) => s.showAlternatives);
  const k = useRouteStore((s) => s.alternativesK);
  const state = useRouteStore((s) => s.alternatives);
  const start = useMapStore((s) => s.start);
  const end = useMapStore((s) => s.end);
  const version = useMapStore((s) => s.version);
  const waypoints = useMapStore((s) => s.waypoints);
  const edges = useMapStore((s) => s.edges);
  const r = routeStore.getState();

  const routes = currentAlternatives({ start, end, version, waypoints }, { alternatives: state, showAlternatives: show });
  const main = routes?.[0];

  return (
    <div className="alternatives">
      <div className="alternatives-head">
        <label title="Find the next-cheapest routes too (Yen's k-shortest loopless paths)">
          <input type="checkbox" checked={show} onChange={r.toggleAlternatives} /> Alternative routes
        </label>
        {show && (
          <select value={k} onChange={(e) => r.setAlternativesK(Number(e.target.value))} aria-label="Number of routes">
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                best {n}
              </option>
            ))}
          </select>
        )}
        {show && state?.status === 'running' && <span className="badge">Finding…</span>}
      </div>
      {show && waypoints.length > 0 && <p className="muted small">Alternatives are for direct routes; remove the stops to see them.</p>}
      {show && state?.status === 'error' && <p className="note error small">{state.error}</p>}
      {show && routes && main && routes.length === 1 && <p className="muted small">This is the only loopless route.</p>}
      {show && routes && main && routes.length > 1 && (
        <ol className="alternative-list">
          {routes.map((route, i) => (
            <li key={route.pathRoads.join(',') || 'empty'}>
              {i === 0 ? <span className="swatch" style={{ background: ROUTE_COLORS.route }} /> : <span className="swatch dashed" style={{ borderColor: alternativeColor(i - 1) }} />}
              <span className="alt-name">{i === 0 ? 'Best' : `Route ${i + 1}`}</span>
              <span className="alt-cost">
                {formatNumber(route.cost)}
                {i > 0 && main.cost > 0 && <span className="muted"> +{((route.cost / main.cost - 1) * 100).toFixed(1)}%</span>}
              </span>
              <span className="muted alt-shared">{i === 0 ? `${route.path.length} stops` : `${Math.round(sharedDistance(route, main, edges) * 100)}% shared`}</span>
            </li>
          ))}
        </ol>
      )}
      {show && routes && state && routes.length > 1 && (
        <p className="muted small">
          {state.spurSearches.toLocaleString()} spur searches in {state.timeMs < 1 ? state.timeMs.toFixed(2) : state.timeMs.toFixed(0)} ms. "Shared" is the share of each route's distance on roads the best route also uses.
        </p>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface NoRouteDetailsProps {
  info: NoRouteInfo | null;
  method: 'search' | 'reachability' | null;
  result: SearchResult;
  algorithmLabel: string;
  startBlocked: boolean;
  endBlocked: boolean;
  meta: RouteMeta | null;
}

/** "start", "stop 2", "the destination": names a leg's ends on a route with waypoints. */
function legName(meta: RouteMeta, leg: number): string {
  const from = leg === 0 ? 'the start' : `stop ${leg}`;
  const to = leg === meta.legs - 1 ? 'the destination' : `stop ${leg + 1}`;
  return `Leg ${leg + 1} (${from} → ${to})`;
}

/**
 * "No route available", with what is cut off, what is blocking it, how it was
 * detected, and a one-click way to clear the closures and obstacles involved.
 */
function NoRouteDetails({ info, method, result, algorithmLabel, startBlocked, endBlocked, meta }: NoRouteDetailsProps) {
  const multiLeg = meta !== null && meta.legs > 1 && meta.failedLeg !== null;
  // On a multi-leg route, "start"/"destination" below refer to the failed leg's ends.
  const legPrefix = multiLeg ? `${legName(meta, meta.failedLeg as number)}: ` : '';
  let reason: string;
  if (info?.reason === 'turn-restrictions') reason = 'The destination can be reached, but only by making a banned turn. Allow one of the turns (select an intersection) to reconnect.';
  else if (multiLeg && info?.reason === 'blocked-start') reason = 'its start is blocked by an obstacle.';
  else if (multiLeg && info?.reason === 'blocked-end') reason = 'its end is blocked by an obstacle.';
  else if (multiLeg && info) reason = `its ${info.side} is cut off (${plural(info.region.length, 'intersection')} shaded red).`;
  else if (startBlocked && endBlocked) reason = 'Both endpoints are blocked by obstacles.';
  else if (info?.reason === 'blocked-start' || startBlocked) reason = 'The start intersection is blocked by an obstacle.';
  else if (info?.reason === 'blocked-end' || endBlocked) reason = 'The destination is blocked by an obstacle.';
  else if (info?.side === 'end' && info.region.length === 1) reason = 'The destination is cut off: no open road leads into it.';
  else if (info?.side === 'start' && info.region.length === 1) reason = 'The start is cut off: no open road leads out of it.';
  else if (info?.side === 'end') reason = `The destination is cut off: the ${plural(info.region.length, 'intersection')} around it (shaded red) can't be reached from the start.`;
  else if (info?.side === 'start') reason = `The start is cut off: only ${plural(info.region.length, 'intersection')} (shaded red) can be reached from it.`;
  else reason = 'Every way to the destination is cut off by closed roads, obstacles or one-way streets.';

  const closed = info?.closedRoads.length ?? 0;
  const oneWay = info?.oneWayRoads.length ?? 0;
  const blocked = info?.reason === 'unreachable' ? (info.blockedNodes.length ?? 0) : 0;
  const barriers = [closed && plural(closed, 'closed road'), blocked && plural(blocked, 'obstacle'), oneWay && plural(oneWay, 'one-way road')].filter(Boolean);

  // Reopening closures and removing obstacles on the boundary (including a
  // blocked endpoint) is what the button offers; one-way roads are left alone.
  const reopenRoads = info?.closedRoads ?? [];
  const reopenNodes = info?.blockedNodes ?? [];
  const canReopen = reopenRoads.length + reopenNodes.length > 0;

  return (
    <div className="route-status no-route" role="status">
      <strong>No route available</strong>
      <span>
        {legPrefix}
        {reason}
      </span>
      {barriers.length > 0 && <span>Blocked by {barriers.join(', ')} (glowing on the map).</span>}
      <span className="muted small">
        {method === 'reachability'
          ? `Detected by a reachability check (BFS, ${result.timeMs.toFixed(2)} ms) over the ${plural(result.nodesExplored, 'intersection')} reachable from the start, so ${algorithmLabel} didn't need to run.`
          : `${algorithmLabel} explored all ${plural(result.nodesExplored, 'intersection')} reachable from the start.`}
      </span>
      {canReopen && (
        <button className="btn" onClick={() => mapStore.getState().reopen(reopenRoads, reopenNodes)}>
          {capitalize([reopenRoads.length && `reopen ${plural(reopenRoads.length, 'road')}`, reopenNodes.length && `remove ${plural(reopenNodes.length, 'obstacle')}`].filter(Boolean).join(' and '))}
        </button>
      )}
      {!canReopen && oneWay > 0 && <span className="muted small">Reverse or make two-way one of the highlighted one-way roads (O tool) to reconnect.</span>}
    </div>
  );
}
