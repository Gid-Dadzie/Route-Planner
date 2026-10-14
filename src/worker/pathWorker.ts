/**
 * Web Worker entry point. All logic lives in PathEngine; this file only wires
 * it to the worker's message port.
 *
 * Loaded from the main thread with Vite's module-worker syntax:
 *   new Worker(new URL('./pathWorker.ts', import.meta.url), { type: 'module' })
 */

import { PathEngine } from './engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** The parts of DedicatedWorkerGlobalScope used here (the project compiles against the DOM lib). */
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const engine = new PathEngine((msg) => scope.postMessage(msg));

scope.onmessage = (event) => engine.handle(event.data);
