/**
 * Algorithm comparison: runs Dijkstra, A* and bidirectional search (and
 * optionally A* with the Manhattan heuristic) on the same endpoints in the
 * worker, and shows cost, nodes explored and time side by side.
 *
 * It doubles as a built-in correctness check: the optimal algorithms must agree
 * on the cost, so any disagreement is flagged as a bug. Clicking a row switches
 * the main route to that algorithm.
 */

import { checkAgreement, entryLabel, excessCost, isOptimal } from '../state/comparison';
import { routeController } from '../state/appRoute';
import { DEFAULT_COMPARE_REPEATS } from '../state/routeController';
import { useMapStore } from '../state/mapStore';
import { routeStore, useRouteStore } from '../state/routeStore';
import { uiStore, useUiStore } from '../state/uiStore';
import type { CompareEntry } from '../worker/protocol';

const fmt = (n: number, digits = 1) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
const fmtMs = (ms: number) => (ms < 1 ? ms.toFixed(2) : ms.toFixed(1));

export function ComparisonPanel() {
  const comparison = useRouteStore((s) => s.comparison);
  const auto = useRouteStore((s) => s.compareAuto);
  const manhattan = useRouteStore((s) => s.compareManhattan);
  const algorithm = useRouteStore((s) => s.algorithm);
  const heuristic = useRouteStore((s) => s.heuristic);
  const start = useMapStore((s) => s.start);
  const end = useMapStore((s) => s.end);
  const version = useMapStore((s) => s.version);
  const r = routeStore.getState();
  const open = useUiStore((s) => s.comparisonOpen);
  const height = useUiStore((s) => s.comparisonHeight);
  const sized = open && height !== null;

  const results = comparison?.results ?? [];
  const agreement = checkAgreement(results);
  const stale = comparison?.for != null && (comparison.for.version !== version || comparison.for.start !== start || comparison.for.end !== end);
  const running = comparison?.status === 'running';
  const dijkstra = results.find((e) => e.algorithm === 'dijkstra');
  const maxExplored = Math.max(1, ...results.map((e) => e.nodesExplored));

  const isCurrent = (e: CompareEntry) => e.algorithm === algorithm && (e.algorithm !== 'astar' || e.heuristic === heuristic);
  const select = (e: CompareEntry) => {
    r.setAlgorithm(e.algorithm);
    if (e.heuristic) r.setHeuristic(e.heuristic);
  };

  return (
    <section className={`comparison${open ? '' : ' collapsed'}${sized ? ' sized' : ''}`} style={sized ? { height } : undefined} aria-labelledby="comparison-title">
      <div className="comparison-head">
        <h2 id="comparison-title">
          <button className="panel-toggle" aria-expanded={open} aria-controls="comparison-body" onClick={uiStore.getState().toggleComparison} title="Show or hide the comparison table">
            <span className="chevron" aria-hidden="true">
              ▸
            </span>
            Algorithm comparison
          </button>
        </h2>
        <AgreementBadge agreement={agreement} hasResults={results.length > 0} />
        {running && <span className="badge">Running…</span>}
        {stale && !running && <span className="badge muted-badge">Out of date</span>}
        <div className="comparison-controls">
          <label title="Re-run after each route update">
            <input type="checkbox" checked={auto} onChange={r.toggleCompareAuto} /> Auto
          </label>
          <label title="Add A* with the Manhattan heuristic, which can overestimate">
            <input type="checkbox" checked={manhattan} onChange={r.toggleCompareManhattan} /> Include A* (Manhattan)
          </label>
          <button className="btn" onClick={() => routeController.compareAll()} disabled={!start || !end}>
            Run comparison
          </button>
        </div>
      </div>

      {!open ? null : !start || !end ? (
        <p className="muted">Place a start and a destination to compare the algorithms.</p>
      ) : comparison?.status === 'error' ? (
        <p className="note error">{comparison.error}</p>
      ) : results.length === 0 ? (
        <p className="muted">{running ? 'Running every algorithm on this route…' : 'Press "Run comparison" to run every algorithm on this route.'}</p>
      ) : (
        <>
          {agreement.status === 'mismatch' && (
            <p className="status-line critical" role="alert">
              <span aria-hidden="true">✕</span> {agreement.message}
            </p>
          )}
          <div className={`table-wrap${stale ? ' stale' : ''}`}>
            <table className="comparison-table">
              <thead>
                <tr>
                  <th scope="col">Algorithm</th>
                  <th scope="col" className="num">
                    Path cost
                  </th>
                  <th scope="col" className="num">
                    Intersections
                  </th>
                  <th scope="col" className="num">
                    Nodes explored
                  </th>
                  <th scope="col" className="bar-col">
                    <span className="visually-hidden">Nodes explored, relative</span>
                  </th>
                  <th scope="col" className="num">
                    vs Dijkstra
                  </th>
                  <th scope="col" className="num">
                    Time (ms)
                  </th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {results.map((e) => {
                  const label = entryLabel(e);
                  const excess = excessCost(e, agreement);
                  const optimal = isOptimal(e);
                  const share = dijkstra && dijkstra.nodesExplored > 0 ? e.nodesExplored / dijkstra.nodesExplored : null;
                  const offender = agreement.status === 'mismatch' && agreement.offenders.includes(e);
                  return (
                    <tr
                      key={`${e.algorithm}-${e.heuristic ?? ''}`}
                      className={`${isCurrent(e) ? 'current' : ''}${offender ? ' offender' : ''}`}
                      onClick={() => select(e)}
                      title={`Show the ${label} route on the map`}
                    >
                      <th scope="row">
                        <button className="row-link" onClick={(ev) => (ev.stopPropagation(), select(e))}>
                          {label}
                        </button>
                      </th>
                      <td className="num">{e.found ? fmt(e.cost) : '—'}</td>
                      <td className="num">{e.found ? e.intersections.toLocaleString() : '—'}</td>
                      <td className="num">{e.nodesExplored.toLocaleString()}</td>
                      <td className="bar-col" aria-hidden="true">
                        <div className="meter" title={`${label} explored ${e.nodesExplored.toLocaleString()} intersections`}>
                          <div className="meter-fill" style={{ width: `${(e.nodesExplored / maxExplored) * 100}%` }} />
                        </div>
                      </td>
                      <td className="num">{share === null ? '—' : e.algorithm === 'dijkstra' ? 'baseline' : `${Math.round(share * 100)}%`}</td>
                      <td className="num">{fmtMs(e.timeMs)}</td>
                      <td>
                        {!e.found ? (
                          <span className="muted">No route</span>
                        ) : offender ? (
                          <span className="tag critical">✕ Mismatch</span>
                        ) : excess === null && !optimal ? (
                          <span className="muted">—</span>
                        ) : excess !== null && excess > 0 ? (
                          <span className="tag warning" title="Manhattan distance can overestimate on diagonal roads, so A* may settle for a longer route">
                            ! +{(excess * 100).toFixed(2)}% (not admissible)
                          </span>
                        ) : optimal ? (
                          <span className="tag good">✓ Optimal</span>
                        ) : (
                          <span className="tag good">✓ Optimal here</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small comparison-foot">
            Times are the median of {DEFAULT_COMPARE_REPEATS} runs after a warm-up, measured in the worker. Click a row to show that algorithm's route and exploration on the map.
          </p>
        </>
      )}
    </section>
  );
}

function AgreementBadge({ agreement, hasResults }: { agreement: ReturnType<typeof checkAgreement>; hasResults: boolean }) {
  if (!hasResults || agreement.status === 'empty') return null;
  if (agreement.status === 'mismatch') {
    return (
      <span className="tag critical" role="status">
        ✕ Costs disagree: bug
      </span>
    );
  }
  return (
    <span className="tag good" role="status">
      ✓ {agreement.found ? `All optimal algorithms agree: cost ${fmt(agreement.cost)}` : 'All agree: no route'}
    </span>
  );
}
