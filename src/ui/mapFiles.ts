/**
 * Browser glue for saving and loading map files: downloads, file reading and
 * user-facing messages. The format itself lives in utils/serialization.ts.
 */

import { mapStore, selectDocument } from '../state/mapStore';
import { parseMap, serializeMap, suggestedFileName } from '../utils/serialization';

export interface LoadOutcome {
  ok: boolean;
  /** A one-paragraph message for the user (errors or warnings included). */
  message: string;
}

/** Triggers a browser download of `blob`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads the current map as JSON. */
export function saveMapFile(): void {
  const json = serializeMap(selectDocument(mapStore.getState()));
  downloadBlob(new Blob([json], { type: 'application/json' }), suggestedFileName());
}

/** Reads, validates and loads a map file, replacing the current map on success. */
export async function loadMapFile(file: File): Promise<LoadOutcome> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: `Could not read "${file.name}".` };
  }
  const parsed = parseMap(text);
  if (!parsed.ok) return { ok: false, message: `"${file.name}" was not loaded: ${parsed.errors.join(' ')}` };

  const { network, ...extras } = parsed.map;
  mapStore.getState().loadNetwork(network, extras);
  const summary = `Loaded "${file.name}": ${network.nodes.length.toLocaleString()} intersections, ${network.edges.length.toLocaleString()} roads.`;
  return { ok: true, message: parsed.warnings.length ? `${summary} ${parsed.warnings.join(' ')}` : summary };
}
