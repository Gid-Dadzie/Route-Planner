/**
 * On-screen view controls in the map's corner: zoom in, zoom out, fit the
 * whole map, zoom to the route. For trackpads, touchscreens and anyone
 * without a mouse wheel; each also has a keyboard shortcut.
 */

interface MapControlsProps {
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
  onRoute(): void;
  hasRoute: boolean;
}

export function MapControls({ onZoomIn, onZoomOut, onFit, onRoute, hasRoute }: MapControlsProps) {
  return (
    <div className="map-controls" role="toolbar" aria-label="Map view">
      <button onClick={onZoomIn} title="Zoom in (+)" aria-label="Zoom in">
        +
      </button>
      <button onClick={onZoomOut} title="Zoom out (−)" aria-label="Zoom out">
        −
      </button>
      <button onClick={onFit} title="Fit the whole map (F)" aria-label="Fit the whole map">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
        </svg>
      </button>
      <button onClick={onRoute} disabled={!hasRoute} title="Zoom to the route (Z)" aria-label="Zoom to the route">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="12.5" r="1.8" />
          <circle cx="12.5" cy="3.5" r="1.8" />
          <path d="M4.8 11.2C7 9 6 7 8 6s3-1 3.2-1.2" />
        </svg>
      </button>
    </div>
  );
}
