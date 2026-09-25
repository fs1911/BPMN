# Roadmap

Ordered by impact on real modeling work.

## Near term
1. **Sub-process drill-down** — open an expanded/collapsed sub-process as its own
   plane with breadcrumb navigation; per-scope layout already supported by the
   engine (`layoutScope(model, subProcessId)`).
2. **In-canvas pool/lane editing** — drag-resize pools, add/remove/reorder lanes,
   drag elements between lanes with live re-banding.
3. **Cross-pool message-flow drawing** — quick-connect that detects pool
   boundaries and creates message flows with anchored ports.
4. **Context pad** — per-element hover toolbar (append task, append gateway,
   add boundary event, change type) for faster manual modeling.
5. **Edge waypoint editing** — drag bend points; lock manually-routed edges so a
   *Clean up flows* preserves user intent where present.

## Routing / layout quality
6. **Hanan-grid router** — replace the uniform grid with a sparse
   coordinate-derived grid for faster routing on large diagrams and tighter bends.
7. **Lane-crossing minimisation** — order lanes to reduce flows that hop lanes;
   bundle parallel same-direction flows.
8. ~~**Label placement solver**~~ — done (`src/core/layout/labels.ts`).
8b. **Keep routes inside the pool** — some flows between lanes currently run
   along or below the pool border (visible on LLM-generated diagrams with
   parallel branches).
9. **Mental-map preservation** — incremental layout that minimises movement of
   unchanged elements after an edit (currently a full deterministic re-layout).

## AI
10. ~~**Streaming LLM extraction** + accept/reject preview~~ — done (edge
    function + Graph IR). Next: an **eval set of real process texts** to measure
    generation quality, and **LLM-based instruction updates** (send the current
    Graph IR + instruction, get a new Graph IR back).
11. **Grounded provenance highlighting** — hover an element to highlight the
    source sentence, and vice-versa.
12. **Clarification dialog** — when ambiguities are detected, ask the user the
    surfaced questions and fold answers back into the IR before mapping.
13. **More instruction verbs** — merge/duplicate branches, convert task↔sub-
    process, extract selection into a sub-process, add compensation/boundary
    timers.

## Product
14. **Collaboration / persistence** — autosave, file open/save, shareable links.
15. **Element styling & themes**, minimap, fit-to-selection, alignment &
    distribution toolbar (align left/center, distribute H/V) exposed in the UI
    (distribution math already exists in the layout engine).
16. **BPMN execution semantics lint** — token-simulation-based dead-path and
    deadlock detection on top of the current structural validation.
17. **Performance** — virtualized rendering for 1k+ element diagrams.
