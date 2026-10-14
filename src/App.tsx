import { ComparisonPanel } from './ui/ComparisonPanel';
import { useUiStore } from './state/uiStore';
import { MapCanvas } from './ui/MapCanvas';
import { MapPanel } from './ui/MapPanel';
import { NetworkPanel } from './ui/NetworkPanel';
import { RouteSummary } from './ui/RouteSummary';
import { Toolbar } from './ui/Toolbar';
import { TrafficPanel } from './ui/TrafficPanel';
import { WorkspaceResizers } from './ui/WorkspaceResizers';

/** Layout: toolbar on top, canvas in the centre, panels on the right, comparison at the bottom. */
export function App() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  return (
    <div className={`app${sidebarOpen ? '' : ' no-sidebar'}`} style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}>
      <Toolbar />
      <main className="map-area">
        <MapCanvas />
        <WorkspaceResizers />
      </main>
      {sidebarOpen && (
        <aside className="sidebar">
          <RouteSummary />
          <TrafficPanel />
          <MapPanel />
          <NetworkPanel />
        </aside>
      )}
      <ComparisonPanel />
    </div>
  );
}
