/**
 * Binary min-heap priority queue.
 *
 * Items and priorities live in two parallel arrays, so push/pop never allocate
 * a wrapper object. That matters in the search hot loops, which push one entry
 * per edge relaxation.
 *
 * There is deliberately no decrease-key. Searches use lazy deletion instead:
 * when a node's distance improves, push a duplicate entry with the better
 * priority, and when popping, skip entries whose priority is worse than the
 * best known distance:
 *
 *   const d = heap.peekPriority();
 *   const u = heap.pop()!;
 *   if (d > dist[u]) continue; // stale entry
 *
 * Complexity: push O(log n), pop O(log n), peek/peekPriority/size O(1).
 */
export class MinHeap<T> {
  private items: T[] = [];
  private priorities: number[] = [];

  /** Number of entries currently in the heap (including stale duplicates). */
  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Inserts `item` with the given priority. Lower priority pops first. */
  push(item: T, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);
    this.siftUp(this.items.length - 1);
  }

  /** Removes and returns the item with the smallest priority, or undefined if empty. */
  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;

    const top = this.items[0];
    const lastItem = this.items.pop() as T;
    const lastPriority = this.priorities.pop() as number;

    if (n > 1) {
      // Move the last entry to the root and restore the heap property.
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      this.siftDown(0);
    }
    return top;
  }

  /** Returns the item with the smallest priority without removing it. */
  peek(): T | undefined {
    return this.items.length === 0 ? undefined : this.items[0];
  }

  /**
   * Returns the smallest priority, or +Infinity if the heap is empty.
   * Returning Infinity (rather than undefined) lets bidirectional search write
   * `topF + topB >= mu` without special-casing empty queues.
   */
  peekPriority(): number {
    return this.priorities.length === 0 ? Infinity : this.priorities[0];
  }

  clear(): void {
    this.items.length = 0;
    this.priorities.length = 0;
  }

  /**
   * Moves the entry at `index` up until its parent is not larger.
   * Uses the "hole" technique: the moving entry is written once at the end
   * instead of being swapped at every level.
   */
  private siftUp(index: number): void {
    const items = this.items;
    const prio = this.priorities;
    const item = items[index] as T;
    const p = prio[index];

    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentPriority = prio[parent];
      if (parentPriority <= p) break;
      items[i] = items[parent] as T;
      prio[i] = parentPriority;
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }

  /** Moves the entry at `index` down until both children are not smaller. */
  private siftDown(index: number): void {
    const items = this.items;
    const prio = this.priorities;
    const n = items.length;
    const item = items[index] as T;
    const p = prio[index];

    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;

      // Pick the smaller child.
      let child = left;
      let childPriority = prio[left];
      if (right < n && prio[right] < childPriority) {
        child = right;
        childPriority = prio[right];
      }
      if (childPriority >= p) break;

      items[i] = items[child] as T;
      prio[i] = childPriority;
      i = child;
    }
    items[i] = item;
    prio[i] = p;
  }
}
