/**
 * Map panel: generate stress-test maps, apply time-of-day traffic, and save,
 * load or export the map.
 */

import { useRef, useState } from 'react';
import { mapStore, useMapStore } from '../state/mapStore';
import { generateMap, MAP_SIZES, type MapKind } from '../utils/mapGenerator';
import { TRAFFIC_PRESETS } from '../utils/trafficPresets';
import { exportRouteImage } from './exportImage';
import { loadMapFile, saveMapFile } from './mapFiles';

type Message = { text: string; tone: 'ok' | 'error' } | null;

const KINDS: ReadonlyArray<{ id: MapKind; label: string; title: string }> = [
  { id: 'grid', label: 'City grid', title: 'Jittered grid with diagonals, one-way streets and winding roads' },
  { id: 'geometric', label: 'Organic', title: 'Random geometric graph: evenly spread random points joined by a Gabriel graph (planar, connected)' },
];

export function MapPanel() {
  const [kind, setKind] = useState<MapKind>('geometric');
  const [size, setSize] = useState(1000);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const turnCount = useMapStore((s) => s.turnRestrictions.size);
  const roadCount = useMapStore((s) => s.edges.size);

  const generate = () => {
    setBusy(true);
    setMessage(null);
    // Let React paint the busy state before the (main-thread, one-off) generation.
    window.setTimeout(() => {
      try {
        const t0 = performance.now();
        const map = generateMap(kind, size, seed);
        const ms = performance.now() - t0;
        mapStore.getState().loadNetwork(map.network, { start: map.start, end: map.end });
        setMessage({
          tone: 'ok',
          text: `Generated ${map.network.nodes.length.toLocaleString()} intersections and ${map.network.edges.length.toLocaleString()} roads in ${Math.round(ms)} ms (seed ${seed}).`,
        });
      } catch (err) {
        setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    }, 16);
  };

  const applyPreset = (id: (typeof TRAFFIC_PRESETS)[number]['id'], label: string) => {
    const changed = mapStore.getState().applyTrafficPreset(id);
    setMessage({ tone: 'ok', text: `${label}: ${changed.toLocaleString()} of ${roadCount.toLocaleString()} roads changed traffic level.` });
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow loading the same file again
    if (!file) return;
    const outcome = await loadMapFile(file);
    setMessage({ tone: outcome.ok ? 'ok' : 'error', text: outcome.message });
  };

  const exportImage = async () => {
    try {
      await exportRouteImage();
    } catch (err) {
      setMessage({ tone: 'error', text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <section className="panel">
      <h2>Map</h2>

      <div className="field">
        <span>Generate</span>
        <div className="segmented" role="radiogroup" aria-label="Map type">
          {KINDS.map((k) => (
            <button key={k.id} role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'active' : ''} title={k.title} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="inline-fields">
          <label>
            Size{' '}
            <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {MAP_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed <input type="number" min={1} step={1} value={seed} onChange={(e) => setSeed(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          </label>
          <button className="btn icon-btn" title="Random seed" onClick={() => setSeed(1 + Math.floor(Math.random() * 99999))}>
            ⟳
          </button>
        </div>
        <button className="btn primary" onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate map'}
        </button>
      </div>

      <div className="field">
        <span>Time of day</span>
        <div className="segmented">
          {TRAFFIC_PRESETS.map((p) => (
            <button key={p.id} title={p.description} onClick={() => applyPreset(p.id, p.label)} disabled={roadCount === 0}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>File</span>
        <div className="actions">
          <button className="btn" onClick={saveMapFile} title="Download the map, pins, stops and turn restrictions as JSON">
            Save JSON
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} title="Load a map saved as JSON (or drop the file on the map)">
            Load JSON
          </button>
          <button className="btn" onClick={() => void exportImage()} title="Download a PNG of the route with its numbers">
            Export PNG
          </button>
        </div>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e)} />
      </div>

      {turnCount > 0 && (
        <p className="muted small turn-summary">
          {turnCount.toLocaleString()} banned turn{turnCount === 1 ? '' : 's'} (red arcs on the map).{' '}
          <button className="link-btn" onClick={() => mapStore.getState().clearTurnRestrictions()}>
            Allow all turns
          </button>
        </p>
      )}

      {message && (
        <p className={message.tone === 'error' ? 'note error small' : 'muted small'} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}
