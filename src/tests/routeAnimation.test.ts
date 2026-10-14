import { describe, expect, it } from 'vitest';
import { animationFrameAt, finalFrame, ROUTE_DRAW_MS, WAVE_MAX_MS, WAVE_MIN_MS, waveDurationMs } from '../ui/routeAnimation';

describe('route animation timeline', () => {
  it('scales the wave with the number of explored nodes, within bounds', () => {
    expect(waveDurationMs(1)).toBe(WAVE_MIN_MS);
    expect(waveDurationMs(300)).toBe(1500);
    expect(waveDurationMs(1_000_000)).toBe(WAVE_MAX_MS);
  });

  it('starts empty and ends in the final state', () => {
    expect(animationFrameAt(500, 0)).toMatchObject({ revealed: 0, routeProgress: 0, done: false });
    expect(animationFrameAt(500, 1e6)).toEqual(finalFrame(500));
    expect(finalFrame(500)).toEqual({ revealed: 500, frontier: 0, routeProgress: 1, done: true });
  });

  it('reveals explored nodes monotonically, then draws the route', () => {
    const n = 400;
    const wave = waveDurationMs(n);
    let prevRevealed = 0;
    let prevProgress = 0;
    for (let t = 0; t <= wave + ROUTE_DRAW_MS; t += 16) {
      const f = animationFrameAt(n, t);
      expect(f.revealed).toBeGreaterThanOrEqual(prevRevealed);
      expect(f.routeProgress).toBeGreaterThanOrEqual(prevProgress);
      expect(f.frontier).toBeLessThanOrEqual(f.revealed);
      // The route only starts drawing once the wave has finished.
      if (t < wave) expect(f.routeProgress).toBe(0);
      prevRevealed = f.revealed;
      prevProgress = f.routeProgress;
    }
    expect(animationFrameAt(n, wave).revealed).toBe(n);
  });

  it('moves the wavefront at a steady speed (revealed count ~ t^2)', () => {
    const n = 10_000;
    const wave = waveDurationMs(n);
    // Halfway through the wave, a quarter of the nodes are revealed.
    expect(animationFrameAt(n, wave / 2).revealed).toBe(2500);
  });

  it('handles an empty explored list', () => {
    expect(animationFrameAt(0, 100)).toMatchObject({ revealed: 0, frontier: 0 });
  });
});
