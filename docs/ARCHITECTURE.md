# Architecture notes

## Data flow

```
            ┌─────────────── UI (React + SVG) ───────────────┐
            │  Canvas · Palette · Toolbar · Panels · AiPanel  │
            └───────────────┬─────────────────▲──────────────┘
                            │ actions          │ model + issues + review
                   ┌────────▼──────────────────┴────────┐
                   │      zustand store (src/state)      │
                   │  model · History(undo/redo) · view  │
                   └────────┬──────────────────▲─────────┘
                            │ mutate            │ new model
        ┌───────────────────▼───────────────────┴───────────────────┐
        │                     src/core (no DOM)                      │
        │  model ─ graph ─ layout ─ routing ─ validation ─ xml ─ ai  │
        └────────────────────────────────────────────────────────────┘
```

Every state mutation produces a new model object (clone-on-write), commits a
deep-clone snapshot to `History`, then re-validates. Drag operations mutate a
working clone live and coalesce into one undo step on pointer-up.

## Layout (`src/core/layout/layered.ts`)

1. Build the sequence-flow adjacency for the scope.
2. **Detect back edges** with an iterative DFS (`detectBackEdges`). Back edges
   close cycles and are flagged on the model (`edge.isBackEdge`).
3. **Rank** nodes by longest path over forward edges only (back edges removed),
   so loop targets never get dragged into a later column.
4. **Reduce crossings** with weighted-median down/up sweeps.
5. **Assign Y** by barycenter of neighbours, then hard-resolve overlaps per rank.
6. **Lane variant:** keep the global rank for X, size each lane to its busiest
   column, and place nodes within their lane band (clamped, overlap-resolved).
7. Place boundary events on their host's bottom border.

## Routing (`src/core/routing/router.ts`)

- **Forward edges:** uniform grid, **direction-aware A\*** (state = cell × incoming
  direction) with a turn penalty so routes are orthogonal, dodge inflated node
  obstacles, and minimise bends. Ports are fanned along node sides so gateway
  splits/joins leave/enter at distinct points. A perpendicular stub guarantees
  clean exits. Collinear points are simplified to minimal waypoints.
- **Back edges:** bypass A\* entirely. Each back edge is folded into its own
  horizontal **channel below the content** (`contentBottom + gap·(k+1)`), source
  bottom → channel → target bottom. This keeps the forward reading direction
  intact, prevents loop lines from cutting through the main path, and
  guarantees multiple loops never stack on the same line.
- **Message flows:** simple top/bottom side-to-side orthogonal routes between
  pools.

## AI pipeline (`src/core/ai`)

`extract.ts` (NL → IR) → `map.ts` (IR → BPMN, validate, layout, route) with
`instructions.ts` for in-place updates. The LLM (`llm.ts`) — when configured —
only emits IR JSON; it never writes BPMN or touches the canvas. The IR records
`provenance` for every step so the review panel can trace each diagram element
back to the source text, and lists `assumptions`/`ambiguities` instead of
inventing process logic.
