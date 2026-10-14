# Intelligent Route Planning & Pathfinding Engine

A visual route planner. You build a road network (intersections, roads, traffic, obstacles, closures, turn restrictions), then compute routes with Dijkstra, A*, bidirectional search and D* Lite, through optional stops, with alternative routes. All searches run in a Web Worker, so the UI stays responsive while roads close and routes are recalculated.

Stack: React, TypeScript, Vite, HTML Canvas, Web Workers, Zustand and Vitest. There is no backend.

## Setup

Requires Node 18 or newer.

```bash
npm install
npm test            # run the unit tests once
npm run test:watch  # rerun the tests on save
npm run typecheck   # strict TypeScript check
npm run dev         # start the dev server at http://localhost:5173
npm run build       # typecheck and build for production
```

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Graph types, min-heap, tests | Done |
| 2 | Dijkstra + tests | Done |
| 3 | Map editor on canvas | Done |
| 4 | Route display and exploration animation | Done |
| 5 | A* | Done |
| 6 | Web Worker (protocol, deltas, request IDs, debounce, cancellation) | Done |
| 7 | Dynamic closures and the "no route" state | Done |
| 8 | Bidirectional search | Done |
| 9 | Comparison panel | Done |
| 10 | Polish, save/load, generator, bonus features | Done |

## Architecture notes

### Two graph representations (`src/core/graph.ts`)

- **`RoadNetwork`**: the editable, serializable model the UI uses. Ids are strings, and a two-way road is a single `GraphEdge` with `oneWay: false`.
- **`SearchGraph`**: the compiled adjacency list the algorithms run on. Nodes and roads get dense numeric indices. Adjacency is packed in CSR form (`offsets`, `target`, `road` as `Int32Array`), and coordinates and costs are stored in `Float64Array`. A two-way road becomes two directed arcs and a one-way road becomes one. A reversed adjacency (`in`) is built for the backward half of bidirectional search.

Every arc points back to its road index. Closed state, traffic level and cached cost are stored per road, so the worker applies a delta (close, open, set traffic, block) as an O(1) write. The graph is never rebuilt for these changes.

### Invariants enforced by `validateNetwork`

- Every road has a finite distance greater than 0, so every cost is positive and Dijkstra and A* stay correct.
- Every road's distance is at least its straight-line length, so the Euclidean heuristic never overestimates and A* stays optimal.
- Ids are unique, endpoints exist and there are no self-loops.

### Cost model

`cost = distance × multiplier`. The multipliers are 1.0 (green), 1.5 (yellow), 2.5 (orange) and 4.0 (red). Closed roads and arcs into blocked intersections are skipped during search.

### Priority queue (`src/core/priorityQueue.ts`)

A binary min-heap stores items and priorities in parallel arrays, so it allocates nothing per entry. It has no decrease-key. Searches use lazy deletion instead: push a duplicate entry with the better priority, then skip stale entries when popping. `peekPriority()` returns `Infinity` when the heap is empty, which keeps the bidirectional stopping rule `topF + topB >= mu` simple.

### Resumable searches (`src/core/search.ts`)

Each algorithm is a generator over node indices (`SearchRun`). It pauses with `yield` every `yieldEvery` expansions (default 500) and returns an `IndexedSearchResult` when it finishes. The synchronous wrappers such as `dijkstra(g, startId, endId)` run it to completion. The worker runs it in time slices instead. A worker cannot receive messages while a synchronous loop is running, so these pauses are what let it process a newer request and abandon the old search with `run.return()`.

`SearchResult` holds `path` and `pathRoads` (ids), `cost`, `distance`, `found`, `exploredInOrder`, `nodesExplored` and `timeMs`.

### Dijkstra (`src/core/dijkstra.ts`)

Dijkstra uses the binary heap with lazy deletion and reads directly from the packed adjacency and typed arrays. Closed roads and arcs into blocked intersections are skipped. A blocked start or goal returns "no route".

Measured on a grid from corner to corner (Node 24): 1,024 nodes in about 0.1 ms and 10,000 nodes in about 0.7 ms. The targets are 20 ms and 200 ms.

### Test oracle

`src/tests/helpers.ts` provides `referenceCost`, a Bellman-Ford implementation that works directly on the editable `RoadNetwork`. It shares no code with the compiled graph or the heap. Random-graph tests compare every algorithm against it. `expectValidRoute` also checks that each returned route is legal (correct road directions, no closed roads, no blocked nodes) and that its reported cost and distance add up.

### Map editor (`src/state`, `src/ui`, `src/utils`)

- **Store (`state/mapStore.ts`):** Zustand. Nodes and roads are kept in id-keyed `Map`s that are replaced on every change, so a new value can be detected by comparing identity. `version` counts every change. `structureVersion` counts only shape and geometry changes. Closures, traffic and obstacles leave it unchanged, so Phase 6 can send them to the worker as small deltas.
- **Distance rule:** a new road's distance is its straight-line length. Distances typed into the inspector are raised to at least that length. A moved intersection scales each connected road by its winding ratio, so the network always passes `validateNetwork`.
- **Canvas (`ui/MapCanvas.tsx`, `ui/renderMap.ts`):** the canvas subscribes to the store outside React, and a `requestAnimationFrame` loop redraws only when something changed. The view transform and hover state live in refs, so panning and hovering never re-render React. Hit testing uses a grid-bucket spatial index (`utils/spatialIndex.ts`).
- **Drawing:** off-screen roads and nodes are skipped. Roads are drawn as one path per style. Nodes are drawn as one batched circle path, or as direct `fillRect` calls when zoomed out. Arrows, labels and node outlines are dropped when they would be too small to read.

| Canvas redraw (headless Edge, 1120×740) | Whole map visible | Zoomed in |
|---|---|---|
| 2,500 nodes / 4,768 roads | ~12 ms | ~4 ms |
| 10,000 nodes / 19,379 roads | ~9.5 ms | ~4.4 ms |

The 10,000-node map is slightly faster than the 2,500-node one because at that zoom its nodes are drawn as plain rectangles.

### Controls

| Key | Tool | Click action |
|---|---|---|
| V | Select | Inspect a road or intersection; drag a node to move it |
| N | Add intersection | Click empty space |
| R | Draw road | Click a node, then another (chains; Esc or right-click stops) |
| O | One-way | Cycles two-way → one-way → reversed → two-way |
| T | Traffic | Applies the brush level (1-4 keys pick the level) |
| B | Obstacle | Blocks or unblocks an intersection |
| C | Close road | Closes or reopens a road (dashed red) |
| M | Move | Drag an intersection |
| X | Delete | Removes a road, or an intersection and its roads |
| S / E | Start / End | Places the A / B pin |
| W | Stop | Adds or removes an intermediate stop (waypoint) |

Other keys: **L** toggles labels, **Esc** cancels, **Delete** removes the selection, **P** shows or hides the side panels.

### Moving around the map

| With | Pan | Zoom | Other |
|---|---|---|---|
| Mouse | Drag empty space (or right/middle drag) | Wheel, around the cursor | |
| Touch | One finger | Two-finger pinch (the map follows your fingers) | |
| Keyboard | Arrow keys (Shift: bigger steps) | **+** / **−** | **F** fits the map, **Z** zooms to the route, **/** jumps to Find |
| On screen | | **+** / **−** buttons (bottom right) | Fit map, zoom to route |

- **Find** (top left of the map): type an intersection id or label. Matches are ranked exact id, then id prefix, then label. Enter or a click centres the map on the intersection, selects it and pulses it. Each result also has **A** / **B** / **+** buttons to make it the start, the destination or a stop.
- **Panels:** every sidebar section (Route, Traffic, Selection, Map, Network) collapses from its heading, and so does the comparison table at the bottom. **Panels** (P) hides the sidebar to give the map the full width. These choices are remembered in the browser (`localStorage`).
- **Resizing the workspace:** the map's right and bottom edges each have a small arrow handle. On the right edge, **◀** widens the side panel (the map gets narrower) and **▶** narrows it, hiding it at its minimum. On the bottom edge, **▲** enlarges the comparison table and **▼** shrinks it, folding it at its minimum. The opposite arrow brings a hidden panel back at its previous size. Each step is 80 px, and the map always keeps at least 280 × 160 px. The edges can also be dragged, or focused with Tab and moved with the arrow keys; double-click or **Home** resets the layout. Sizes are remembered. On phone-width screens the panels stack under the map, so the handles are hidden.
- **Zoom to route** frames the route with its pins and stops, and never zooms in closer than 3×. Focusing an intersection zooms in to at least 1.4× if the view is further out.

### Route display (`state/routeStore.ts`, `state/routeController.ts`, `ui/routeAnimation.ts`)

- **Route store:** holds the selected algorithm, the latest `SearchResult`, the endpoints and map version it was computed for, and display options (show explored, animate, auto-update).
- **Route controller:** watches the map store and recomputes when the pins, the algorithm or the map change. Only pin changes, algorithm changes, Recalculate and Replay play the exploration wave. Map edits (closures, traffic, moves) update the route instantly, so the wave doesn't replay on every drag. Since Phase 6 the search runs in a Web Worker (see below).
- **Animation:** a pure timeline function of elapsed time. Explored nodes are revealed in the order the search settled them, and the most recent ones are drawn bright as the wavefront. The count revealed grows with t², because on a 2D map that makes the front move at a steady speed. The route line then draws from A to B. The wave lasts 5 ms per explored node, between 1 s and 2.5 s.
- **Drawing order:** explored halos (opaque tint, under the roads) → roads → route line (light casing with a blue core) → intersections → pins. When zoomed out so far that intersections are under 2 px, only roads, obstacles, the explored tint and the route are drawn.
- **Route summary:** shows total cost, distance, intersections on the route, nodes explored, search time and algorithm. It also covers missing pins, start equal to end, a blocked start or end, "no route available" (with the likely cause), and errors.

### A* (`src/core/astar.ts`, `src/core/heuristics.ts`)

A* uses priority `f = g + h`, a closed set and the same heap with lazy deletion as Dijkstra, and it can be paused the same way. The heuristic for each node is computed once and cached.

- **Euclidean (default):** every road's cost is at least its straight-line length, because distance is never below it and traffic multipliers are at least 1. So straight-line distance never overestimates, and it satisfies the triangle inequality. A* therefore always returns the optimal cost. Tests check this against Dijkstra on 500 random networks and 20 generated cities, and A* also runs the full shared correctness suite (`tests/pathSuite.ts`).
- **Manhattan (optional):** `|dx| + |dy|` can be up to √2 times the straight-line distance, so it overestimates on diagonal roads and the route may not be optimal. The UI warns about this. A test shows a 3-node case where it returns 16 instead of 14.14. It is optimal only on axis-aligned grids, which a test also confirms.

Measured on a 10,000-node generated city:

| Trip | Dijkstra explored | A* (Euclidean) explored | A* (Manhattan) explored, cost vs optimal |
|---|---|---|---|
| Corner → corner | 9,998 | 8,279 | 994, +1.04% |
| Mid-left → mid-right | 9,264 | 3,799 | 2,065, +0.11% |
| Short hop | 43 | 8 | 7, +0% |

A* saves the least on long diagonal trips across congested maps. The heuristic counts only distance, while real costs average about 1.4× distance because of traffic. That leaves the estimate loose, so A* still expands much of the map. Scaling the heuristic by the minimum multiplier would not help, since that minimum is 1.0 whenever any road is free-flowing.

### Web Worker (`src/worker`)

The main thread never runs a search. Here is how the pieces fit:

| File | Role |
|---|---|
| `protocol.ts` | Message types: `loadGraph`, `applyDelta`, `findRoute`, `compareAll` → `routeResult`, `compareResult`, `error` |
| `engine.ts` | `PathEngine`: the worker's graph copy, delta application, time-sliced searches, cancellation. Pure TypeScript with injected I/O, so it is tested in Node |
| `pathWorker.ts` | Thin worker entry that wires `PathEngine` to `self.onmessage` |
| `transport.ts` | The real module Worker, plus an in-process transport (structured-cloned, asynchronous) used by tests and as a fallback |
| `client.ts` | Main-thread client: graph sync, request ids, drops stale responses |
| `graphDiff.ts` | Turns map edits into deltas, and decides when the current route is provably still optimal |

**Cancellation.** A worker can't receive messages while a synchronous loop runs. Searches are therefore generators that pause every 500 expansions. When the current 8 ms slice is used up, the engine yields to the event loop, using a `MessageChannel` macrotask rather than `setTimeout`, which adds a delay of at least a few milliseconds. Queued messages are handled during the pause. When the search resumes, it is abandoned if a newer request has arrived. If the graph changed in the meantime, it is restarted, so a route can never use a road that closed mid-search.

**Graph sync.** The full graph is sent only when its shape changes: an intersection or road added or removed, or a road's endpoints or direction changed. Everything else travels as small deltas: `closeEdge`, `openEdge`, `setTraffic`, `blockNode`, `unblockNode`, and two additions to the spec, `moveNode` and `setDistance`. The additions keep node drags off the full-reload path, which costs about 24 ms of main-thread copying for 10,000 nodes. The client diffs the map against the last copy it sent. Because the store is copy-on-write, only changed objects are inspected.

**Recalculation policy** (`state/routeController.ts`):
- Endpoint, algorithm and heuristic changes are sent immediately.
- Map edits are debounced by 75 ms, with a 250 ms maximum wait so the route keeps up during long drags.
- Every request gets an increasing id. Only the response to the latest one is applied.
- Recalculation is skipped when every edit since the last result makes roads worse (closed, heavier traffic, blocked) and none touches the route. Reopening a road, lighter traffic and geometry edits always trigger a recalculation.
- The old route stays visible. If a request takes more than 100 ms, the route fades and "Recalculating…" appears.

**Measured on a 10,000-node map** (headless Edge, software rendering):

| Scenario | Result |
|---|---|
| Closure on the route → updated route | median 86 ms, max 103 ms (including the 75 ms debounce); target under 300 ms |
| 15 closures, frame gaps on the main thread | median 16.7 ms, max 17.1 ms, 0 long tasks |
| Burst of 10 closures 15 ms apart | 1 request, final route about 240 ms after the first click |
| Dragging an intersection | median 16.7 ms, p95 16.9 ms, 0 long tasks; 27 live route updates sent as 135 deltas, with no full reloads |
| Same search on the main thread, for comparison | 12 ms to compile + 6 ms of Dijkstra, blocking |

Two main-thread fixes came out of this measurement:
- **Drag preview.** The canvas draws the dragged intersection at the pointer every frame but commits it to the store only every 100 ms. Committing 60 times a second copied 30,000-entry maps, and the resulting garbage collection halved the frame rate.
- **Explored halos.** They are now drawn opaque, under the roads, with `fillRect` when small. 10,000 overlapping translucent circles had cost 35 ms per frame.

### Closures and the "no route" state (`src/core/traversal.ts`)

**Reachability first.** Before each weighted search, the worker runs a breadth-first search (BFS) from the start that stops when it reaches the goal. If the goal is unreachable, it answers immediately with `method: 'reachability'` and Dijkstra or A* never runs. On a 10,000-node map, a "no route" answer takes about 0.4 ms. The BFS adds about 1 ms when a route does exist (2.3 ms in total, versus about 1.3 ms for Dijkstra alone).

**Explaining the cut-off.** When there's no route, `explainNoRoute` compares two sets: the intersections reachable from the start (forward BFS) and those that can reach the end (BFS over the reversed graph). It highlights the smaller set, which is usually the pocket that was cut off, and lists the barriers on its boundary:
- closed roads;
- blocked neighbouring intersections;
- open one-way roads that only cross the boundary in the wrong direction.

The map tints the region red, makes the barrier roads glow (red for closed, orange for wrong-way one-way) and rings the obstacles. The route panel names the cause, reports how it was detected, and offers a one-click **Reopen** for the closures and obstacles involved, using `mapStore.reopen` as a single change.

**Network health.** `analyzeNetwork` runs an iterative depth-first search (DFS) over open roads, ignoring direction. It counts the disconnected regions and finds isolated intersections, which are ringed in red with a dashed line. It runs in the worker 150 ms after edits settle, as an `analyze` request, and the result appears in the Network panel.

**Skipping work, refined.** While there's no route, every edit triggers a recalculation, even a further closure. The answer can't change, but the cut-off highlight can, and the BFS that recomputes it is cheap.

**The project document's manual scenarios run as automated tests** (`tests/scenarios.test.ts`). They go end to end through the store, the controller and the engine, and check each result against Dijkstra:
1. Close a road on the route → it detours, and the route no longer uses that road.
2. Close every road into the destination → "no route" from the reachability check, with the destination highlighted and exactly those roads listed. **Reopen** restores the route.
3. Raise traffic on the route level by level → it switches to the alternative once that becomes cheaper, and every intermediate route is optimal.
4. Reopen a road → the original route and cost come back.

The fifth scenario (a 10,000-node map, repeated closures, no stutter) was measured in the browser in Phase 6.

### Bidirectional search (`src/core/bidirectional.ts`)

Two Dijkstra searches run at once: forward from the start over `g.out`, and backward from the destination over the reversed graph `g.in`. Using the reversed graph means one-way roads are respected in both directions. Each step expands the side with the smaller queue.

- **Meeting.** The first node settled by both sides is not necessarily on the optimal path. Whenever a relaxed arc `u → v` reaches a node already labelled by the other side, the search records the candidate `mu = distF[u] + cost + distB[v]` together with that arc. The route is rebuilt through the recorded arc: forward parents back to the start, then backward parents on to the destination.
- **Stopping rule.** The search stops only when `topF + topB >= mu`. Stale heap entries can only make a top priority look smaller, which delays the stop but never triggers it early. An empty queue has top = Infinity, so if one side runs out before the two meet, the loop ends with `mu = Infinity`, meaning no route.
- **The trap, tested.** `tests/bidirectional.test.ts` builds a 5-node map where the first node both sides settle lies on a worse route. A naive "stop at the first common node" version, written in the test, returns 15. This implementation returns the optimal 11.2.
- **Checked against Dijkstra.** Costs match on 1,000 random networks (a third of them 70% one-way) and on 20 generated cities, and every returned route is checked for legality. Bidirectional search also passes the full shared suite (`tests/pathSuite.ts`).
- **Visualisation.** `exploredSides` records which side settled each node. It survives the worker boundary as a `Uint8Array`, and the map draws the forward side in violet and the backward side in teal.

All three algorithms on a 10,000-node city, measured in Node 24 (same cost on every trip):

| Trip | Dijkstra (nodes / time) | A* | Bidirectional |
|---|---|---|---|
| Corner → corner | 9,998 / 1.24 ms | 8,279 / 1.62 ms | 8,228 / 1.35 ms |
| Mid-left → mid-right | 9,264 / 1.20 ms | 3,799 / 0.73 ms | 7,059 / 1.19 ms |
| Short hop | 43 / 0.06 ms | 8 / 0.09 ms | 25 / 0.12 ms |

Bidirectional explores 18–24% fewer nodes than Dijkstra on long trips. The textbook figure is half: two circles of radius r/2 cover half the area of one circle of radius r. On a bounded map the single large circle is already clipped by the map's edges, so the saving shrinks. With traffic making costs uneven, A* wins on trips across the middle of the map.

### Comparison panel (`ui/ComparisonPanel.tsx`, `state/comparison.ts`)

The panel runs every algorithm on the current start and end in the worker, through a `compareAll` request. The rows are Dijkstra, A* (Euclidean) and bidirectional search, plus A* (Manhattan) if you tick the option. Columns:
- path cost;
- intersections on the route;
- nodes explored, with a bar and the share relative to Dijkstra;
- time;
- result.

How it runs:
- **Fair timing.** Each algorithm gets one untimed warm-up run, then 5 timed runs, and the median is shown. A single sub-millisecond run is mostly timer noise. Unlike `findRoute`, there's no reachability shortcut here, because the point is to compare the searches themselves.
- **Built-in correctness check.** The three optimal algorithms must report the same cost (within a relative 1e-9, since costs are summed in different orders). `checkAgreement` takes a majority vote, so a disagreement names the faulty algorithm, shown in a red "bug" banner. Without a majority, every optimal result is flagged. A* (Manhattan) is excluded from the vote. It is measured against the agreed cost and labelled "+x% (not admissible)" in amber, because overestimating is expected for it.
- **Auto mode** (the default). The comparison re-runs 300 ms after each route result, once edits have settled, so its 6 runs per algorithm don't compete with routing in the worker. A newer comparison cancels an older one, and results go grey ("Out of date") when they no longer match the map.
- **Click a row** to show that algorithm's route and exploration on the map.

The nodes-explored bars are a single-series meter: one hue, no legend, a rounded end anchored at the baseline, and values in their own column. The bar colour `#7489ea` was checked with the dataviz validator against the dark surface (lightness band, chroma, contrast at least 3:1).

### Phase 10: polish and bonus features

All of the project document's bonus features are implemented: generator, save/load, alternative routes, waypoints, turn restrictions, time-of-day presets, image export and D* Lite. The **Map** panel in the sidebar holds the generator, presets and file actions.

#### Map generator (`utils/mapGenerator.ts`)

- **City grid:** the jittered grid used for the demo map.
- **Organic:** a random geometric graph. Points are spread evenly at random (one per cell of a jittered grid, so none clump). They are joined by a *Gabriel graph*: p and q are connected when no other point lies inside the circle whose diameter is pq. That graph is planar (no crossing roads), contains the minimum spanning tree (so it is connected) and has an average degree near 5. A repair pass joins any leftover components, though none occurred in testing.
- Sizes from 100 to 10,000 intersections, and a seed, so every map can be reproduced.

| Generate (Node 24) | Intersections / roads | Time | Regions |
|---|---|---|---|
| Organic, 10,000 | 10,000 / 24,854 | 42 ms | 1 |
| City grid, 10,000 | 9,954 / 19,284 | 7 ms | 1 |

Tests check validity, the exact node count, connectivity, determinism and planarity (no two roads cross on a 400-node map).

#### Save / load (`utils/serialization.ts`, `ui/mapFiles.ts`)

**Save JSON** downloads the map with its pins, stops and turn restrictions. **Load JSON** (or dropping a file on the map) replaces the current map. The format is `{ format: "route-planner-map", version: 1, nodes, edges, start, end, waypoints, turnRestrictions }`.

Loading is forgiving where that is safe and strict where it isn't:
- A bare `{ nodes, edges }` object is accepted.
- Missing flags default to `false`, a missing traffic level to 1, and a missing distance to the straight-line length.
- A distance below the straight-line length is **raised** to it, with a warning. A shorter distance would make the A* heuristic overestimate.
- Pins, stops and turn bans that point at missing elements are dropped, with a warning.
- Bad JSON, missing ids or coordinates, duplicate ids, dangling roads, self-loops, bad traffic levels and files from a newer version are rejected with a list of errors. The current map is left untouched.

A 10,000-node organic map saves to about 3.2 MB and loads back identically.

#### Time-of-day traffic (`utils/trafficPresets.ts`)

**Night**, **Midday** and **Rush hour** set every road's level at once. Each road gets a congestion score: a centrality weight times how central the road is, plus a noise weight times a stable per-road value (a hash of the road id). Rush hour weights the centre heavily, so the core jams while the outer roads stay usable. Night is almost all free flow. Because the noise is a hash rather than a random draw, presets are repeatable.

A preset touches most roads. When more than 32 deltas are queued, the client sends them as one `applyDeltas` message instead of one message each.

#### Waypoints (Stop tool, **W**)

Click intersections to add stops, in visiting order. They are listed in the route panel with ↑ ↓ ✕ controls (up to 8). The worker runs the chosen algorithm once per leg (start → stop 1 → … → end) and concatenates the legs. Each leg gets its own reachability check. If a leg has no route, the panel names it ("Leg 2 (stop 1 → stop 2)"). The comparison panel compares whole multi-leg routes.

#### Turn restrictions (intersection inspector)

Select an intersection to see every turn possible there, grouped by the road you arrive on and labelled ↰ left, ↑ straight, ↱ right or ↶ U-turn from the geometry. Click a turn to ban or allow it. Banned turns show on the map as red arcs with a bar across them. The Map panel shows the total count and an "Allow all turns" button.

**How it works (`core/turns.ts`).** A node-based search can't enforce "no left turn from road r1 onto r2". The cheapest arrival at an intersection might come by a road whose onward turn is banned, while a dearer arrival would allow that turn, and Dijkstra keeps only the cheapest. When bans exist, each search therefore runs on the **line graph**:
- each directed arc of the road network becomes a node ("just arrived at v by this road");
- each allowed turn becomes an arc;
- a source node feeds the start and a zero-cost sink drains the goal.

That is an ordinary `SearchGraph`, so Dijkstra, A*, bidirectional search, D* Lite and Yen run on it unchanged. A* stays admissible, because every line-graph node sits at its arc's head. Line-graph arcs keep their road's index, so closures and traffic are copied in before each search, and only the topology is cached (per start and goal). If the destination can be reached but only through banned turns, the panel says so.

Limitation: restrictions don't carry across a waypoint, so each leg starts fresh.

Tested against an independent Bellman-Ford over (intersection, arriving road) states on 150 random networks with about 30% of turns banned, for all four algorithms.

#### Alternative routes (`core/kShortest.ts`)

Tick **Alternative routes** to show the best 2–5 routes using Yen's k-shortest loopless paths, with Lawler's refinement (spurs start at the parent route's deviation point). Alternatives are drawn dashed under the main route. The panel lists each route's cost, its extra cost as a percentage, and the share of its distance on roads the best route also uses.

Spur searches are A* with per-arc and per-node ban masks. The arrays are reused through stamping, so a spur search costs O(1) to start. They are time-sliced and cancellable like every other search.

Tested against brute-force enumeration of all loopless routes on 120 small random graphs.

Two caveats:
- On grids, the true 2nd- and 3rd-cheapest routes are often small detours (for example +0.0%, 95% shared on a 10,000-node map). That is what k-shortest paths means, not a diversity heuristic.
- Corner-to-corner on 10,000 nodes, k = 3 takes about 280 spur searches and 190 ms in the worker.

With turn bans, routes that revisit an intersection (such as a U-turn and back) are dropped from the alternatives. The best route is always kept. Alternatives are not offered for routes with stops.

#### Export PNG (`ui/exportImage.ts`)

Re-renders the map off-screen at 3200 × 2000, framed on the route and stops. It includes the finished route, alternatives, pins and a caption (endpoints, cost, distance, intersections, nodes explored, algorithm). Nothing on screen changes.

#### D* Lite (`core/dstarLite.ts`): a fourth algorithm

D* Lite searches backward from the destination and keeps its search between requests. Each node has g (cost-to-goal at its last expansion) and rhs (a one-step lookahead). A closure or traffic change only makes the changed arc's source inconsistent. Those nodes are queued by `[min(g, rhs) + h + km, min(g, rhs)]` and expanded until the start is consistent. Moving the start keeps the search too: the heuristic drift accumulates in `km`.

- **In the worker:** `findRoute` keeps one persistent instance per destination (up to 6, least recently used). Deltas are forwarded to the instances as they arrive. A request that a change interrupts simply continues the same instance. Moving an intersection changes the heuristic, so those instances restart.
- **Bulk changes:** a batch touching more than 5% of roads (such as a traffic preset) also restarts them, because repairing most of a search costs more than redoing it. Measured: rush hour on 10,000 nodes was 16,187 re-expansions as a repair, against 8,710 from scratch.
- **Comparison panel:** D* Lite always runs from scratch there, so its timing is comparable with the others.
- **Route panel:** says whether the result was a repair and how many intersections were re-expanded. An unchanged map re-expands nothing.

Repair cost depends on where the change is. The search grows from the destination, so a closure near the start invalidates little, and one near the destination invalidates most of the tree. Closing one road at a given point along the route on a 10,000-node grid (all repaired costs equal Dijkstra's):

| Closed road at … of the route | 10% | 30% | 50% | 70% | 90% |
|---|---|---|---|---|---|
| Nodes re-expanded (first search: 8,908) | 106 | 750 | 2,946 | 4,010 | 8,872 |

Tested on the shared correctness suite, and through 60 random sequences of 25 edits and start moves each, checked against a fresh Dijkstra after every step.

#### Tests

316 tests across 20 files (229 before Phase 10). The navigation work later added `navigation.test.ts`, which brings the total to 325 in 21 files. New: `turns`, `dstarLite`, `kShortest` and `serialization`, plus additions to the generator, store, engine, client and controller suites.

The UI was smoke-tested in headless Edge with no console errors:
- algorithm switching;
- alternatives;
- stops and turn bans, including the turn editor;
- a D* Lite repair after a closure;
- the four-way comparison agreeing;
- generating a 10,000-node map;
- rush hour;
- PNG export;
- a JSON round trip.
