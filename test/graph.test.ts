import { SSE_HEADERS, claudeSse } from "../scripts/lib/claude-sse.mjs";
import { describe, expect, it } from "vitest";
import {
  LlmUnavailableError,
  assessModel,
  generateFromTextSync,
  generateViaLlm,
  mapGraphToModel,
  sanitizeGraphIR,
} from "../src/core/ai";
import { exportBpmn, importBpmn } from "../src/core/xml";
import reclamationGraph from "../samples/llm-reklamation.json";

const RECLAMATION_TEXT =
  "Wenn ein Kunde reklamiert, schaut sich der Support das erst mal an. Ist es ein Garantiefall, geht das Gerät ans Lager, die schicken Ersatz raus. Sonst bekommt der Kunde ein Angebot für die Reparatur. Lehnt er ab, war's das. Parallel dazu wird im CRM ein Ticket gepflegt.";

/** What a good LLM answer for RECLAMATION_TEXT looks like (also used by scripts/smoke-llm.mjs). */
const RECLAMATION_GRAPH = reclamationGraph;

describe("Graph IR → BPMN", () => {
  it("maps alternative paths with their own activities and parallel split/join", () => {
    const { ir, repairs } = sanitizeGraphIR(RECLAMATION_GRAPH);
    expect(repairs).toEqual([]);
    const { model, review } = mapGraphToModel(ir, { sourceText: RECLAMATION_TEXT });

    const nodes = Object.values(model.nodes);
    expect(nodes.filter((n) => n.type === "parallelGateway")).toHaveLength(2);
    expect(nodes.filter((n) => n.type === "endEvent")).toHaveLength(2);
    // both alternatives keep their own activity
    const names = nodes.map((n) => n.name);
    expect(names).toContain("Ersatzgerät versenden");
    expect(names).toContain("Reparaturangebot senden");
    // every node sits in a lane; the unassigned join/end inherited one
    expect(nodes.every((n) => n.lane)).toBe(true);
    // conditions only on the XOR split flows
    const conditional = Object.values(model.edges).filter((e) => e.condition);
    expect(conditional).toHaveLength(4);

    expect(review.source).toBe("llm");
    expect(review.findings).toEqual([]);
    expect(review.confidence).toBeGreaterThan(0.9);
    expect(review.decisions).toEqual(["Garantiefall?", "Angebot angenommen?"]);
    expect(review.roles).toEqual(["Support", "Lager"]);
  });

  it("round-trips through BPMN XML with geometry", () => {
    const { ir } = sanitizeGraphIR(RECLAMATION_GRAPH);
    const { model } = mapGraphToModel(ir);
    const back = importBpmn(exportBpmn(model));
    expect(Object.keys(back.nodes)).toHaveLength(Object.keys(model.nodes).length);
    expect(Object.keys(back.edges)).toHaveLength(Object.keys(model.edges).length);
    expect(Object.values(back.nodes).every((n) => n.bounds.width > 0)).toBe(true);
  });

  it("renders rework flows as back edges", () => {
    const { ir } = sanitizeGraphIR({
      lang: "de",
      nodes: [
        { id: "s", type: "startEvent", name: "Antrag eingegangen", lane: "", event: "none", source: "" },
        { id: "a", type: "userTask", name: "Antrag prüfen", lane: "", event: "none", source: "" },
        { id: "g", type: "exclusiveGateway", name: "Vollständig?", lane: "", event: "none", source: "" },
        { id: "b", type: "userTask", name: "Unterlagen nachfordern", lane: "", event: "none", source: "" },
        { id: "e", type: "endEvent", name: "Antrag geprüft", lane: "", event: "none", source: "" },
      ],
      flows: [
        { from: "s", to: "a", condition: "", isDefault: false },
        { from: "a", to: "g", condition: "", isDefault: false },
        { from: "g", to: "e", condition: "ja", isDefault: false },
        { from: "g", to: "b", condition: "nein", isDefault: false },
        { from: "b", to: "a", condition: "", isDefault: false },
      ],
    });
    const { model, review } = mapGraphToModel(ir);
    expect(Object.values(model.edges).filter((e) => e.isBackEdge)).toHaveLength(1);
    expect(review.loops).toHaveLength(1);
    expect(Object.keys(model.lanes)).toHaveLength(0);
  });
});

describe("sanitizeGraphIR", () => {
  it("repairs broken LLM output and reports every repair", () => {
    const { ir, repairs } = sanitizeGraphIR({
      lang: "de",
      lanes: [{ id: "l1", name: "Vertrieb" }],
      nodes: [
        { id: "a", type: "userTask", name: "Angebot erstellen", lane: "l1", event: "none", source: "" },
        { id: "a", type: "userTask", name: "Duplikat", lane: "l1", event: "none", source: "" },
        { id: "b", type: "frobnicate", name: "Angebot senden", lane: "l9", event: "weird", source: "" },
      ],
      flows: [
        { from: "a", to: "b", condition: "", isDefault: false },
        { from: "b", to: "ghost", condition: "", isDefault: false },
      ],
    });
    expect(ir.nodes.find((n) => n.id === "b")).toMatchObject({ type: "task", lane: "", event: "none" });
    expect(ir.nodes.filter((n) => n.type === "startEvent")).toHaveLength(1);
    expect(ir.nodes.filter((n) => n.type === "endEvent")).toHaveLength(1);
    expect(ir.flows.every((f) => ir.nodes.some((n) => n.id === f.from) && ir.nodes.some((n) => n.id === f.to))).toBe(true);
    expect(repairs.length).toBeGreaterThanOrEqual(4);

    const { review } = mapGraphToModel(ir, { repairs });
    expect(review.findings!.length).toBeGreaterThanOrEqual(repairs.length);
    expect(review.confidence).toBeLessThan(0.8);
  });

  it("tolerates garbage", () => {
    expect(sanitizeGraphIR(null).ir.nodes).toEqual([]);
    expect(sanitizeGraphIR("x").ir.nodes).toEqual([]);
  });
});

describe("quality assessment", () => {
  it("no longer reports high confidence for mangled rule-based output", () => {
    const { review } = generateFromTextSync(RECLAMATION_TEXT);
    expect(review.source).toBe("rules");
    expect(review.confidence).toBeLessThan(0.6);
    expect(review.findings!.some((f) => f.includes("Satzfragment"))).toBe(true);
    expect(review.findings!.some((f) => f.includes("Parallel"))).toBe(true);
  });

  it("flags missing steps against the source text", () => {
    const { review } = generateFromTextSync(
      "Neue Mitarbeiter: HR legt den Vertrag an und gleichzeitig bestellt die IT den Laptop. Sobald beides fertig ist, begrüßt der Teamleiter die Person am ersten Tag.",
    );
    expect(review.confidence).toBeLessThan(0.9);
  });

  it("keeps clean diagrams clean", () => {
    const { ir } = sanitizeGraphIR(RECLAMATION_GRAPH);
    const { model } = mapGraphToModel(ir);
    expect(assessModel(model).findings).toEqual([]);
  });
});

describe("generateViaLlm (Claude event stream)", () => {
  // Response body split into small, odd-sized chunks to exercise buffering.
  const sse = (body: string, chunkSize = 17) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.length; i += chunkSize) c.enqueue(enc.encode(body.slice(i, i + chunkSize)));
        c.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  };
  const jsonError = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the stream, reports progress and maps the result", async () => {
    const phases: string[] = [];
    const res = await generateViaLlm(RECLAMATION_TEXT, {
      fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH)),
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases[0]).toBe("thinking");
    expect(phases).toContain("writing");
    expect(res.review.source).toBe("llm");
    expect(Object.values(res.model.nodes).some((n) => n.type === "parallelGateway")).toBe(true);
  });

  it("joins the text around a mid-answer fallback (partial + continuation)", async () => {
    const res = await generateViaLlm(RECLAMATION_TEXT, { fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH, { fallback: true }), 5) });
    expect(res.ir.nodes.length).toBe(RECLAMATION_GRAPH.nodes.length);
  });

  it("treats a missing endpoint, key or network as unavailable (→ offline fallback)", async () => {
    await expect(
      generateViaLlm("x", { fetchImpl: async () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }) }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(generateViaLlm("x", { fetchImpl: async () => jsonError(503, { code: "no_key", message: "kein Key" }) })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    await expect(generateViaLlm("x", { fetchImpl: async () => jsonError(401, { error: "login_required" }) })).rejects.toThrow("Anmeldung abgelaufen");
    await expect(
      generateViaLlm("x", {
        fetchImpl: async () => {
          throw new TypeError("network");
        },
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("surfaces server errors, refusals, truncation, overload and lost connections", async () => {
    await expect(generateViaLlm("x", { fetchImpl: async () => jsonError(400, { code: "bad_input", message: "Text zu lang" }) })).rejects.toThrow("Text zu lang");
    await expect(generateViaLlm("x", { fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH, { stopReason: "refusal" })) })).rejects.toThrow("abgelehnt");
    await expect(generateViaLlm("x", { fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH, { stopReason: "max_tokens" })) })).rejects.toThrow("abgeschnitten");
    await expect(generateViaLlm("x", { fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH, { error: "overloaded_error" })) })).rejects.toThrow("ausgelastet");
    await expect(generateViaLlm("x", { fetchImpl: async () => sse(claudeSse(RECLAMATION_GRAPH, { cutAfter: 9 })) })).rejects.toThrow("unvollständig");
  });
});
