/**
 * Message transports between the main thread and the engine.
 *
 * - `createWorkerTransport`: the real thing, a module Web Worker.
 * - `createInProcessTransport`: the same engine on the current thread, with
 *   asynchronous delivery and structured cloning in both directions so it
 *   behaves like a worker boundary. Used by tests, and as a fallback where
 *   Worker is unavailable.
 */

import { PathEngine, type EngineOptions } from './engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface RouteTransport {
  post(msg: WorkerRequest): void;
  /** Registers the single response listener. */
  onMessage(listener: (msg: WorkerResponse) => void): void;
  /** Fired if the worker crashes (uncaught error inside it). */
  onFatalError(listener: (message: string) => void): void;
  terminate(): void;
}

export function createWorkerTransport(): RouteTransport {
  const worker = new Worker(new URL('./pathWorker.ts', import.meta.url), { type: 'module', name: 'pathfinding' });
  return {
    post: (msg) => worker.postMessage(msg),
    onMessage: (listener) => {
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => listener(e.data);
    },
    onFatalError: (listener) => {
      worker.onerror = (e) => listener(e.message || 'The pathfinding worker crashed.');
    },
    terminate: () => worker.terminate(),
  };
}

export interface InProcessTransport extends RouteTransport {
  readonly engine: PathEngine;
  /** Every request posted, in order (for tests). */
  readonly sent: WorkerRequest[];
}

export interface InProcessOptions extends EngineOptions {
  /** Delay before each message is delivered, in ms (default 0: next macrotask). */
  latencyMs?: number;
}

export function createInProcessTransport(options: InProcessOptions = {}): InProcessTransport {
  const latency = options.latencyMs ?? 0;
  let listener: ((msg: WorkerResponse) => void) | null = null;
  let terminated = false;
  const sent: WorkerRequest[] = [];

  const engine = new PathEngine((msg) => {
    const copy = structuredClone(msg);
    setTimeout(() => !terminated && listener?.(copy), latency);
  }, options);

  return {
    engine,
    sent,
    post: (msg) => {
      sent.push(msg);
      const copy = structuredClone(msg);
      setTimeout(() => !terminated && engine.handle(copy), latency);
    },
    onMessage: (l) => {
      listener = l;
    },
    onFatalError: () => {},
    terminate: () => {
      terminated = true;
    },
  };
}

/** A worker where supported, otherwise the in-process engine. */
export function createDefaultTransport(): RouteTransport {
  return typeof Worker !== 'undefined' ? createWorkerTransport() : createInProcessTransport();
}
