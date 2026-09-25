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

## Layout + routing (`src/core/layout`, `src/core/routing`)

Auto-layout (`autoLayout`) routes forward flows *inside* the layered layout —
the approach professional BPMN tools use — and only loops with A*:

1. **Ranks** by longest path over forward edges (back edges found by DFS and
   removed), so a loop never drags its target into a later column.
2. **Dummy nodes** for every rank a long edge skips: the edge reserves a slot in
   each column it passes, so it cannot run through shapes, and it takes part in
   crossing reduction.
3. **Crossing reduction**: weighted-median sweeps + transpose, constrained so
   nodes stay in their lane; run from several start orders (multi-start), best
   kept.
4. **Y assignment** inside lane bands (median pulls, overlap resolution, chain
   straightening → straight main flow, straight long edges). Lanes get extra
   height for loop channels.
5. **Ports**: activities use left/right sides (fanned when shared); gateways
   and events their real corners — a split sends its outer branches out of the
   top/bottom corner, a join takes them in the same way (only if that column
   is free).
6. **Corridor tracks**: every vertical segment between two columns gets its own
   track; tracks are ordered to minimise crossings, and corridors widen to fit
   their tracks and branch labels.
7. **Two variants** for lanes (long cross-lane flows run in the source lane vs.
   the target lane) are computed; the better-measured one wins.

**A\* router** (`router.ts`) — for loops after auto-layout and for all flows in
*Kanten aufräumen* (manual layouts): direction-aware A\* with turn penalty;
horizontal and vertical occupancy tracked separately (running along another
flow = prohibitive, crossing it = penalty); candidate ports (gateway corners,
side points) chosen by the search; confined to the pool; off-grid ports snapped;
a rip-up-and-reroute pass for edges that still cross.

**Labels** (`labels.ts`): node labels and branch conditions placed next to the
gateway exit, avoiding shapes, flows, lane name strips and other labels.

**Guarantees by construction** (verified on 10 000 random processes, see
README): no two flows share a track (one track per vertical segment per
corridor; same-y conflicts are forbidden in the exact track ordering and
resolved by nudging an activity port when a swap makes them unavoidable),
corner routes reserve their column stretch, A* treats running along another
flow as prohibitive and never leaves the pool. Crossings are minimised
(multi-start median/transpose/sifting ordering, exact DP track order,
all-or-nothing corner trunks, A* crossing penalty) but not zero in general.

**Measured quality** (`metrics.ts`): crossings, overlaps, bundles (flows sharing
one gateway corner — standard notation, counted separately), shape hits, flows
outside the pool, node overlaps, label collisions, bends, length.
`npm run bench:layout` prints them for the corpus in `test/fixtures`;
`test/layout-quality.test.ts` gates them.

## Process description + PDF (`src/core/describe`, `src/ui/export/pdf.ts`)

`describeProcess(model)` derives a Q.wiki/Signavio-style description from the
diagram: header fields (placeholders for what a diagram cannot know: purpose,
scope, owner), summary and main path, triggers/outcomes, roles with their
steps, a numbered step table (reading order; short end branches right after
their decision; joins after all branches; loops marked) and open points
(validation issues, missing documentation, AI clarification questions). It is
deterministic — nothing is invented. Element documentation (properties panel →
*Dokumentation*) flows into the step table.

`buildProcessPdf` renders the diagram as vector graphics (bpmn-js SVG →
svg2pdf, A4/A3 landscape by size) plus the description as tables (jsPDF +
autotable), with a running footer. The PDF libraries are loaded on demand.

## AI pipeline (`src/core/ai`)

**LLM path (primary).** `remote.ts` posts the text to
`netlify/edge-functions/generate.ts`, which calls Claude with a fixed prompt and
a JSON schema (`graph-schema.ts`) via structured outputs and streams progress +
the result back as NDJSON. The result is a *Graph IR* — nodes, flows, lanes —
so alternative paths with their own activities, parallel split/join and merges
are expressible. `graph.ts` sanitizes it (unknown ids/types, dangling paths,
missing start/end; every repair is recorded) and maps it to a BpmnModel. The
LLM only emits JSON; it never writes BPMN or touches the canvas.

**AI editing.** `edit.ts` converts the current diagram to Graph IR with its
real element ids (`modelToGraphIR`); the edge function sends it with the
instruction under a separate edit prompt (same modelling rules, "smallest
change, keep ids"); `applyEditedGraph` maps the returned IR with those ids,
carries over what the IR does not hold (documentation, markers, boundary
events and their flows) and passes the previous vertical positions to the
layout as its first crossing-reduction start (`preferOrder`) — ties keep the
old arrangement. `diffGraphs` yields added/changed/removed ids for the preview
highlight and the chat summary.

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
