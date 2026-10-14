import { describe, expect, it } from 'vitest';
import { MinHeap } from '../core/priorityQueue';
import { seededRandom } from './helpers';

/** Pops everything, returning [item, priority] pairs in pop order. */
function drain<T>(heap: MinHeap<T>): Array<[T, number]> {
  const out: Array<[T, number]> = [];
  while (!heap.isEmpty()) {
    const p = heap.peekPriority();
    out.push([heap.pop() as T, p]);
  }
  return out;
}

describe('MinHeap', () => {
  describe('empty queue', () => {
    it('reports size 0 and isEmpty', () => {
      const heap = new MinHeap<string>();
      expect(heap.size).toBe(0);
      expect(heap.isEmpty()).toBe(true);
    });

    it('pop and peek return undefined', () => {
      const heap = new MinHeap<string>();
      expect(heap.pop()).toBeUndefined();
      expect(heap.peek()).toBeUndefined();
    });

    it('peekPriority returns Infinity', () => {
      expect(new MinHeap<number>().peekPriority()).toBe(Infinity);
    });

    it('becomes empty again after popping its only element', () => {
      const heap = new MinHeap<string>();
      heap.push('a', 1);
      expect(heap.pop()).toBe('a');
      expect(heap.isEmpty()).toBe(true);
      expect(heap.pop()).toBeUndefined();
    });
  });

  it('pops items in ascending priority order', () => {
    const heap = new MinHeap<string>();
    const input: Array<[string, number]> = [['e', 5], ['b', 2], ['d', 4], ['a', 1], ['c', 3]];
    for (const [item, p] of input) heap.push(item, p);

    expect(heap.size).toBe(5);
    expect(heap.peek()).toBe('a');
    expect(heap.peekPriority()).toBe(1);
    expect(drain(heap).map(([item]) => item)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('peek does not remove the item', () => {
    const heap = new MinHeap<string>();
    heap.push('x', 7);
    expect(heap.peek()).toBe('x');
    expect(heap.size).toBe(1);
  });

  it('handles duplicate priorities', () => {
    const heap = new MinHeap<number>();
    const priorities = [3, 1, 3, 2, 1, 3, 2, 1];
    priorities.forEach((p, i) => heap.push(i, p));

    const popped = drain(heap);
    expect(popped.map(([, p]) => p)).toEqual([1, 1, 1, 2, 2, 3, 3, 3]);
    // Every pushed item comes back exactly once.
    expect(popped.map(([item]) => item).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('supports duplicate items with different priorities (lazy deletion pattern)', () => {
    const heap = new MinHeap<string>();
    const best = new Map<string, number>([['n', 10]]);
    heap.push('n', 10);

    // A better distance is found later: push a duplicate instead of decrease-key.
    best.set('n', 4);
    heap.push('n', 4);
    expect(heap.size).toBe(2);

    const settled: Array<[string, number]> = [];
    while (!heap.isEmpty()) {
      const d = heap.peekPriority();
      const u = heap.pop() as string;
      if (d > (best.get(u) as number)) continue; // stale entry, ignored
      settled.push([u, d]);
    }
    expect(settled).toEqual([['n', 4]]);
  });

  it('handles Infinity, zero and fractional priorities', () => {
    const heap = new MinHeap<string>();
    heap.push('inf', Infinity);
    heap.push('zero', 0);
    heap.push('half', 0.5);
    heap.push('tiny', 1e-12);
    expect(drain(heap).map(([item]) => item)).toEqual(['zero', 'tiny', 'half', 'inf']);
  });

  it('clear empties the heap and it stays usable', () => {
    const heap = new MinHeap<number>();
    for (let i = 0; i < 10; i++) heap.push(i, i);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBeUndefined();
    heap.push(42, 1);
    expect(heap.pop()).toBe(42);
  });

  it('matches a sorted reference over 2,000 random pushes', () => {
    const rand = seededRandom(1);
    const heap = new MinHeap<number>();
    const priorities: number[] = [];
    for (let i = 0; i < 2000; i++) {
      // Small integer range forces many duplicates.
      const p = Math.floor(rand() * 200);
      priorities.push(p);
      heap.push(i, p);
    }
    const popped = drain(heap).map(([, p]) => p);
    expect(popped).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('stays correct under interleaved push and pop', () => {
    const rand = seededRandom(7);
    const heap = new MinHeap<number>();
    const reference: number[] = []; // kept sorted ascending

    for (let step = 0; step < 5000; step++) {
      if (reference.length === 0 || rand() < 0.6) {
        const p = rand() * 1000;
        heap.push(p, p);
        // Insert into the sorted reference.
        let i = 0;
        while (i < reference.length && (reference[i] as number) <= p) i++;
        reference.splice(i, 0, p);
      } else {
        const expected = reference.shift();
        expect(heap.peekPriority()).toBe(expected);
        expect(heap.pop()).toBe(expected);
      }
      expect(heap.size).toBe(reference.length);
    }
  });
});
