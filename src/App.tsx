import { ComparisonPanel } from './ui/ComparisonPanel';
import { MapCanvas } from './ui/MapCanvas';
import { MapPanel } from './ui/MapPanel';
import { NetworkPanel } from './ui/NetworkPanel';
import { RouteSummary } from './ui/RouteSummary';
import { Toolbar } from './ui/Toolbar';
import { TrafficPanel } from './ui/TrafficPanel';

/** Layout: toolbar on top, canvas in the centre, panels on the right, comparison at the bottom. */
export function App() {
  return (
    <div className="app">
      <Toolbar />
      <main className="map-area">
        <MapCanvas />
      </main>
      <aside className="sidebar">
        <RouteSummary />
        <TrafficPanel />
        <MapPanel />
        <NetworkPanel />
      </aside>
      <ComparisonPanel />
    </div>
  );
}
