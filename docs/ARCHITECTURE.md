# Architecture notes

## Data flow

```
   UI (React + bpmn-js)          Modeler · Toolbar · Panels · AiPanel
          │ actions ▲ issues + review
          ▼         │
   zustand store (src/state) ───── POST /api/generate ─────▶ Netlify edge function
          │         ▲        ◀──── NDJSON (Graph IR) ──────       └─▶ Claude API
   saveXML│         │importXML
          ▼         │
   src/core (no DOM): model · layout · routing · validation · xml · ai
```

bpmn-js owns the live diagram and its undo stack. Engine operations (AI
generation, cleanup, validation) read the diagram via `saveXML` → `importBpmn`
and write back via `exportBpmn` → `importXML`.

Consequence: every engine operation re-imports the whole diagram, which resets
bpmn-js' undo stack (AI results are guarded by the accept/reject preview; the
cleanup actions are not) and drops anything the engine's XML model does not
carry (e.g. vendor extension attributes).

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

**LLM path (primary).** `remote.ts` posts the text to
`netlify/edge-functions/generate.ts`, which calls Claude with a fixed prompt and
a JSON schema (`graph-schema.ts`) via structured outputs and streams progress +
the result back as NDJSON. The result is a *Graph IR* — nodes, flows, lanes —
so alternative paths with their own activities, parallel split/join and merges
are expressible. `graph.ts` sanitizes it (unknown ids/types, dangling paths,
missing start/end; every repair is recorded) and maps it to a BpmnModel. The
LLM only emits JSON; it never writes BPMN or touches the canvas.

**Offline path (fallback).** `extract.ts` (rule-based NL → step-list IR) →
`map.ts`. The step-list IR can only express a linear main path whose branches
loop back or end, which is why it is not used as the LLM contract.

**Quality.** `quality.ts` assesses the *produced diagram* for both paths —
sentence fragments as names, gateways that don't branch, unlabeled XOR exits,
unreachable nodes, and mismatches with the text (parallel/conditional cues
without matching gateways, far fewer activities than sentences). Confidence is
derived from these findings, which the review panel lists.

`instructions.ts` applies rule-based in-place updates. Every element keeps
`provenance` (a source quote) and the IR lists `assumptions`/`ambiguities`
instead of inventing process logic.
