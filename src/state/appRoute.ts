/**
 * The app's route controller, wired to the app's store singletons and the
 * pathfinding Web Worker. Kept separate from routeController.ts so tests can
 * build isolated controllers (with an in-process engine) without this
 * module's side effects.
 */

import { createDefaultTransport } from '../worker/transport';
import { mapStore } from './mapStore';
import { createRouteController } from './routeController';
import { routeStore } from './routeStore';

export const routeController = createRouteController(mapStore, routeStore, createDefaultTransport());
