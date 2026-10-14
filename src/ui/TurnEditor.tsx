/**
 * Turn restrictions at one intersection. Lists every turn a vehicle could
 * make there, grouped by the road it arrives on, labelled left / straight /
 * right / U-turn from the geometry. Clicking a turn bans or allows it.
 */

import { classifyTurn, turnKey, type TurnKind } from '../core/turns';
import type { GraphEdge, GraphNode } from '../core/graph';
import { mapStore, useMapStore } from '../state/mapStore';

const TURN_ICONS: Record<TurnKind, string> = { left: '↰', straight: '↑', right: '↱', uturn: '↶' };
const TURN_NAMES: Record<TurnKind, string> = { left: 'Left', straight: 'Straight', right: 'Right', uturn: 'U-turn' };
const TURN_ORDER: readonly TurnKind[] = ['left', 'straight', 'right', 'uturn'];

/** Above this many roads the list gets unwieldy; it is still shown, just noted. */
const BUSY_DEGREE = 6;

export function TurnEditor({ node }: { node: GraphNode }) {
  const nodes = useMapStore((s) => s.nodes);
  const edges = useMapStore((s) => s.edges);
  const restrictions = useMapStore((s) => s.turnRestrictions);

  const touching: GraphEdge[] = [];
  for (const e of edges.values()) if (e.from === node.id || e.to === node.id) touching.push(e);
  const other = (e: GraphEdge) => nodes.get(e.from === node.id ? e.to : e.from);

  // Roads you can arrive by, and roads you can leave by (one-way roads only one of the two).
  const incoming = touching.filter((e) => !e.oneWay || e.to === node.id);
  const outgoing = touching.filter((e) => !e.oneWay || e.from === node.id);

  if (incoming.length === 0 || outgoing.length === 0) {
    return <p className="muted small">No turns here: this intersection needs a road in and a road out.</p>;
  }

  const groups = incoming.map((inRoad) => {
    const a = other(inRoad);
    const turns = outgoing
      .filter((outRoad) => outRoad.id !== inRoad.id || !inRoad.oneWay) // a U-turn needs a two-way road
      .map((outRoad) => {
        const b = other(outRoad);
        const kind: TurnKind = outRoad.id === inRoad.id ? 'uturn' : a && b ? classifyTurn(a.x, a.y, node.x, node.y, b.x, b.y) : 'straight';
        const turn = { fromRoad: inRoad.id, via: node.id, toRoad: outRoad.id };
        return { outRoad, target: b?.id ?? '?', kind, turn, banned: restrictions.has(turnKey(turn)) };
      })
      .sort((x, y) => TURN_ORDER.indexOf(x.kind) - TURN_ORDER.indexOf(y.kind));
    return { inRoad, from: a?.id ?? '?', turns };
  });

  const bannedHere = groups.reduce((n, g) => n + g.turns.filter((t) => t.banned).length, 0);
  const s = mapStore.getState();

  return (
    <div className="turns">
      <div className="turns-head">
        <span>Turns</span>
        {bannedHere > 0 && (
          <button className="link-btn" onClick={() => s.clearTurnRestrictions(node.id)}>
            Allow all ({bannedHere})
          </button>
        )}
      </div>
      {touching.length > BUSY_DEGREE && <p className="muted small">Busy intersection: {touching.length} roads.</p>}
      {groups.map((g) => (
        <div key={g.inRoad.id} className="turn-group">
          <div className="turn-from muted small">
            Arriving from {g.from} <code>{g.inRoad.id}</code>
          </div>
          <div className="turn-chips">
            {g.turns.map((t) => (
              <button
                key={t.outRoad.id}
                className={`turn-chip${t.banned ? ' banned' : ''}`}
                aria-pressed={t.banned}
                title={`${TURN_NAMES[t.kind]} onto ${t.outRoad.id} toward ${t.target}: ${t.banned ? 'banned, click to allow' : 'allowed, click to ban'}`}
                onClick={() => s.toggleTurnRestriction(t.turn)}
              >
                <span aria-hidden="true">{TURN_ICONS[t.kind]}</span> {t.kind === 'uturn' ? 'U-turn' : t.target}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="muted small">Struck-out turns are banned. Routes respect them; each leg between waypoints starts fresh.</p>
    </div>
  );
}
