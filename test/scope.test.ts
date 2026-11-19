import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEADERS, claudeSse } from "../scripts/lib/claude-sse.mjs";
import { handleGenerate } from "../server/llm";
import { GRAPH_IR_SCHEMA, GRAPH_SYSTEM_PROMPT, SCOPE_SCHEMA } from "../src/core/ai/graph-schema";
import { checkScopeViaLlm, focusFor, generateViaLlm, mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { BAUETAPPE } from "./fixtures/processes";

/**
 * Several processes in one text → the AI is asked first (scope check) and the
 * owner chooses; improvement suggestions come with the diagram but are never
 * built into it.
 */

const post = (body: unknown) =>
  new Request("https://x/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const SCOPE = {
  processes: [
    { title: "Rechnung verarbeiten", trigger: "Rechnung eingegangen", summary: "Erfassen, visieren, verbuchen." },
    { title: "Zahlungslauf durchführen", trigger: "jeden Freitag", summary: "Fällige Rechnungen bezahlen." },
    { title: "Mahnwesen", trigger: "monatlich", summary: "Offene Posten mahnen bis zur Betreibung." },
  ],
  relation: "Der Zahlungslauf bezahlt die verbuchten Rechnungen; das Mahnwesen läuft unabhängig.",
};

describe("server: scope check and focus", () => {
  afterEach(() => vi.unstubAllGlobals());
  const upstream = (answer: unknown) => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(claudeSse(answer), { headers: SSE_HEADERS });
    });
    return sent;
  };

  it("scope mode: small schema, low effort, own prompt", async () => {
    const sent = upstream(SCOPE);
    const res = await handleGenerate(post({ mode: "scope", text: "Kreditoren … Zahlungslauf … Mahnwesen" }), { apiKey: "k" });
    expect(res.status).toBe(200);
    expect(sent[0].output_config.format.schema).toEqual(SCOPE_SCHEMA);
    expect(sent[0].output_config.effort).toBe("low");
    expect(sent[0].max_tokens).toBeLessThanOrEqual(8000);
    expect(sent[0].system).toMatch(/one process or several separate processes/);
    expect((await handleGenerate(post({ mode: "scope", text: "" }), { apiKey: "k" })).status).toBe(400);
  });

  it("focus is passed as its own block; the normal generation has none", async () => {
    const sent = upstream(BAUETAPPE);
    await handleGenerate(post({ text: "Langer Text", focus: "Prozess: Mahnwesen" }), { apiKey: "k" });
    expect(sent[0].messages[0].content).toMatch(/<focus>\nProzess: Mahnwesen\n<\/focus>/);
    expect(sent[0].output_config.format.schema).toEqual(GRAPH_IR_SCHEMA);
    await handleGenerate(post({ text: "Langer Text" }), { apiKey: "k" });
    expect(sent[1].messages[0].content).not.toMatch(/<focus>/);
    expect((await handleGenerate(post({ text: "x", focus: "y".repeat(5000) }), { apiKey: "k" })).status).toBe(400);
  });

  it("the prompts carry the focus, layout, best-practice and improvement rules", () => {
    expect(GRAPH_SYSTEM_PROMPT).toMatch(/<focus> block/);
    // profile of the chosen process, not the copied document header
    expect(GRAPH_SYSTEM_PROMPT).toMatch(/describe THIS process, not the whole document/);
    expect(GRAPH_SYSTEM_PROMPT).toMatch(/happy path/);
    expect(GRAPH_SYSTEM_PROMPT).toMatch(/Method and Style/);
    expect(GRAPH_SYSTEM_PROMPT).toMatch(/never built into the graph/);
    expect(GRAPH_IR_SCHEMA.required).toContain("improvements");
  });
});

describe("client: scope check", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the processes; focusFor names the chosen one and the others", async () => {
    const fetchImpl = (async () => new Response(claudeSse(SCOPE), { headers: SSE_HEADERS })) as unknown as typeof fetch;
    const scope = await checkScopeViaLlm("…", { fetchImpl });
    expect(scope.processes.map((p) => p.title)).toEqual(["Rechnung verarbeiten", "Zahlungslauf durchführen", "Mahnwesen"]);
    const focus = focusFor(scope.processes[2], scope.processes);
    expect(focus).toMatch(/^Prozess: Mahnwesen\nAuslöser: monatlich/);
    expect(focus).toMatch(/nicht modellieren\): Rechnung verarbeiten; Zahlungslauf durchführen/);
  });

  it("generateViaLlm sends the focus", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(claudeSse(BAUETAPPE), { headers: SSE_HEADERS });
    }) as unknown as typeof fetch;
    await generateViaLlm("Text", { fetchImpl, focus: "Prozess: Mahnwesen" });
    expect(bodies[0]).toEqual({ text: "Text", focus: "Prozess: Mahnwesen" });
  });
});

describe("improvement suggestions", () => {
  const ir = {
    ...BAUETAPPE,
    improvements: [
      { kind: "automatisierung", title: "Abnahme digital erfassen", description: "Protokoll direkt im System statt auf Papier.", elements: [BAUETAPPE.nodes[1].id, "gibtsnicht"] },
      { kind: "quatsch", title: "Wartezeit verkürzen", description: "…", elements: [] },
      { kind: "best-practice", title: "", description: "ohne Titel", elements: [] },
    ],
  };

  it("are sanitized (unknown kind → optimierung, unknown ids and untitled dropped)", () => {
    const { ir: clean } = sanitizeGraphIR(ir);
    expect(clean.improvements!.map((x) => [x.kind, x.title, x.elements.length])).toEqual([
      ["automatisierung", "Abnahme digital erfassen", 1],
      ["optimierung", "Wartezeit verkürzen", 0],
    ]);
  });

  it("go into the review with diagram ids, and change nothing in the diagram", () => {
    const { ir: clean } = sanitizeGraphIR(ir);
    const withIdeas = mapGraphToModel(clean);
    const without = mapGraphToModel(sanitizeGraphIR({ ...BAUETAPPE, improvements: [] }).ir);
    const imp = withIdeas.review.improvements!;
    expect(imp).toHaveLength(2);
    expect(withIdeas.model.nodes[imp[0].elementIds![0]]?.name).toBe(BAUETAPPE.nodes[1].name);
    const shape = (m: typeof without.model) => Object.values(m.nodes).map((n) => `${n.type}:${n.name ?? ""}`).sort();
    expect(shape(withIdeas.model)).toEqual(shape(without.model));
    expect(Object.keys(withIdeas.model.edges).length).toBe(Object.keys(without.model.edges).length);
    expect(without.review.improvements).toBeUndefined();
  });
});
