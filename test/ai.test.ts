import { describe, expect, it } from "vitest";
import { extractIR, generateFromTextSync, updateByInstruction } from "../src/core/ai";
import { validate } from "../src/core/validation";
import { isActivity } from "../src/core/model";

const INVOICE_PROCESS = `When an invoice is received, the accountant records it in the system.
The accountant checks the invoice against the purchase order.
If the documents are incomplete, send back to record the invoice.
The manager approves the invoice.
The system schedules the payment.
The process ends when the payment is archived.`;

describe("text → BPMN generation", () => {
  it("extracts roles, systems, data objects, decisions and loops", () => {
    const ir = extractIR(INVOICE_PROCESS);
    expect(ir.roles.map((r) => r.toLowerCase()).join(" ")).toMatch(/accountant|manager/);
    expect(ir.systems.length).toBeGreaterThan(0);
    expect(ir.dataObjects.map((d) => d.toLowerCase())).toContain("invoice");
    expect(ir.steps.some((s) => s.kind === "approval")).toBe(true);
    expect(ir.steps.some((s) => s.kind === "check")).toBe(true);
    // a rework loop should be detected
    expect(ir.steps.some((s) => (s.branches ?? []).some((b) => b.loopTo))).toBe(true);
  });

  it("produces an editable, valid, laid-out BPMN model", () => {
    const { model, review } = generateFromTextSync(INVOICE_PROCESS);
    expect(Object.values(model.nodes).some((n) => n.type === "startEvent")).toBe(true);
    expect(Object.values(model.nodes).some((n) => n.type === "endEvent")).toBe(true);
    expect(Object.values(model.nodes).some((n) => n.type === "exclusiveGateway")).toBe(true);
    // everything got laid out
    for (const n of Object.values(model.nodes)) {
      expect(Number.isFinite(n.bounds.x) && Number.isFinite(n.bounds.y)).toBe(true);
    }
    // flows are routed
    expect(Object.values(model.edges).every((e) => e.waypoints && e.waypoints.length >= 2)).toBe(true);
    // no structural errors
    expect(validate(model).filter((i) => i.severity === "error")).toHaveLength(0);
    // review report is populated
    expect(review.roles.length).toBeGreaterThan(0);
    expect(review.confidence).toBeGreaterThan(0);
    expect(Object.keys(review.provenance).length).toBeGreaterThan(0);
  });

  it("creates swimlanes from detected roles", () => {
    const { model } = generateFromTextSync(INVOICE_PROCESS);
    expect(Object.keys(model.lanes).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces ambiguities when roles are missing", () => {
    const ir = extractIR("Do the thing. Then do the next thing. Finish.");
    expect(ir.ambiguities.some((a) => a.about === "responsibility")).toBe(true);
  });
});

describe("instruction → model update", () => {
  it("adds an approval with branches before an anchor", () => {
    const { model } = generateFromTextSync("The clerk prepares the shipment. The shipment is sent.");
    const before = Object.keys(model.nodes).length;
    const res = updateByInstruction(model, "Add an approval by the department head before the shipment is sent");
    expect(res.applied).toBe(true);
    expect(Object.keys(model.nodes).length).toBeGreaterThan(before);
    expect(Object.values(model.nodes).some((n) => /approve/i.test(n.name ?? ""))).toBe(true);
    expect(Object.values(model.nodes).some((n) => n.type === "exclusiveGateway")).toBe(true);
  });

  it("splits roles into separate lanes", () => {
    const { model } = generateFromTextSync("The team handles procurement. The team handles site management.");
    const res = updateByInstruction(model, "Split procurement and site management into separate lanes");
    expect(res.applied).toBe(true);
    const laneNames = Object.values(model.lanes).map((l) => (l.name ?? "").toLowerCase());
    expect(laneNames.join(" ")).toMatch(/procurement/);
    expect(laneNames.join(" ")).toMatch(/site management/);
  });

  it("adds an exception path", () => {
    const { model } = generateFromTextSync("The officer reviews the permit. The permit is filed.");
    const res = updateByInstruction(model, "Add an exception path if the permit is missing");
    expect(res.applied).toBe(true);
    expect(res.affected.length).toBeGreaterThan(0);
    expect(Object.values(model.nodes).some((n) => n.type === "exclusiveGateway")).toBe(true);
  });

  it("replaces a task with an XOR gateway", () => {
    const { model } = generateFromTextSync("The clerk performs the triage. The case is closed.");
    const target = Object.values(model.nodes).find((n) => isActivity(n.type) && /triage/i.test(n.name ?? ""));
    expect(target).toBeTruthy();
    const res = updateByInstruction(model, "Replace the triage with an XOR gateway");
    expect(res.applied).toBe(true);
    expect(model.nodes[target!.id].type).toBe("exclusiveGateway");
  });

  it("re-validates and re-lays-out after an update (no overlaps)", () => {
    const { model } = generateFromTextSync("The clerk prepares the order. The order is shipped.");
    updateByInstruction(model, "Add an approval by the manager before the order is shipped");
    const nodes = Object.values(model.nodes);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].bounds, b = nodes[j].bounds;
        const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it("reports when an instruction cannot be interpreted", () => {
    const { model } = generateFromTextSync("The clerk prepares the order.");
    const res = updateByInstruction(model, "make it more blue and sparkly");
    expect(res.applied).toBe(false);
    expect(res.description).toMatch(/could not interpret/i);
  });
});

const RECHNUNGS_PROZESS = `Wenn eine Rechnung eingeht, erfasst der Sachbearbeiter sie im System.
Der Sachbearbeiter prüft die Rechnung gegen die Bestellung.
Wenn die Unterlagen unvollständig sind, zurück an die Erfassung der Rechnung senden.
Der Abteilungsleiter gibt die Rechnung frei.
Das System plant die Zahlung.
Der Prozess endet, wenn die Zahlung archiviert ist.`;

describe("Deutsch: Text → BPMN", () => {
  it("erkennt Rollen, Systeme, Dokumente, Entscheidungen und Schleifen", () => {
    const ir = extractIR(RECHNUNGS_PROZESS);
    expect(ir.lang).toBe("de");
    expect(ir.roles.join(" ").toLowerCase()).toMatch(/sachbearbeiter|abteilungsleiter/);
    expect(ir.systems.length).toBeGreaterThan(0);
    expect(ir.dataObjects.map((d) => d.toLowerCase()).join(" ")).toMatch(/rechnung/);
    expect(ir.steps.some((s) => s.kind === "approval")).toBe(true);
    expect(ir.steps.some((s) => s.kind === "check")).toBe(true);
    expect(ir.steps.some((s) => (s.branches ?? []).some((b) => b.loopTo))).toBe(true);
  });

  it("erzeugt ein gültiges, deutsch beschriftetes Diagramm", () => {
    const { model, review } = generateFromTextSync(RECHNUNGS_PROZESS);
    expect(validate(model).filter((i) => i.severity === "error")).toHaveLength(0);
    expect(Object.values(model.nodes).some((n) => n.type === "exclusiveGateway")).toBe(true);
    // German branch labels (freigegeben / abgelehnt) appear on edges
    const labels = Object.values(model.edges).map((e) => e.name ?? "").join(" ").toLowerCase();
    expect(labels).toMatch(/freigegeben|abgelehnt|unvollständig|ja|nein/);
    expect(review.roles.length).toBeGreaterThan(0);
  });

  it("verarbeitet deutsche Anweisungen", () => {
    const { model } = generateFromTextSync("Der Sachbearbeiter bereitet die Lieferung vor. Die Lieferung wird versendet.");
    const before = Object.keys(model.nodes).length;
    const res = updateByInstruction(model, "Eine Freigabe durch den Abteilungsleiter vor der Lieferung hinzufügen");
    expect(res.applied).toBe(true);
    expect(Object.keys(model.nodes).length).toBeGreaterThan(before);
    expect(res.description).toMatch(/Freigabe/);
  });

  it("teilt Rollen in separate Bahnen auf (Deutsch)", () => {
    const { model } = generateFromTextSync("Das Team erledigt den Einkauf. Das Team erledigt die Bauleitung.");
    const res = updateByInstruction(model, "Einkauf und Bauleitung in separate Bahnen aufteilen");
    expect(res.applied).toBe(true);
    const laneNames = Object.values(model.lanes).map((l) => (l.name ?? "").toLowerCase()).join(" ");
    expect(laneNames).toMatch(/einkauf/);
    expect(laneNames).toMatch(/bauleitung/);
  });
});
