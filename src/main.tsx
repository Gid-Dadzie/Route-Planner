import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { routeController } from './state/appRoute';
import './styles.css';

// Compute the demo map's initial route; afterwards the controller follows map changes.
routeController.compute('endpoints');

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
