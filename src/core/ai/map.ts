import { autoLayout } from "../layout";
import {
  BpmnModel,
  EventDefinitionType,
  FlowElementType,
  createEdge,
  createLane,
  createNode,
  createParticipant,
  emptyModel,
} from "../model";
import { validate } from "../validation";
import { ProcessIR, ReviewReport, StepIR } from "./types";

/**
 * Map a ProcessIR to a fully laid-out, validated BpmnModel.
 *
 * Decisions and approvals are expanded into proper XOR gateways with named
 * branches; rejected/negative branches either fold back to an earlier step (a
 * rework loop, rendered as a true back edge) or terminate at a dedicated end
 * event. Roles become swimlanes; system-only steps become service tasks placed
 * in a System lane. The result is auto-laid-out and routed so the AI output is
 * an editable, readable diagram rather than raw JSON.
 */

interface Pending {
  from: string;
  condition?: string;
  isDefault?: boolean;
}

export interface MappingResult {
  model: BpmnModel;
  review: ReviewReport;
}

export function mapIrToModel(ir: ProcessIR): MappingResult {
  const model = emptyModel({ processId: "Process_ai", name: ir.title });
  const provenance: Record<string, string> = {};
  const de = ir.lang === "de";
  const lbl = (t?: string) => labelFor(t, de);

  // Lanes from roles (+ a System lane if systems are present).
  const laneByRole: Record<string, string> = {};
  const useLanes = ir.roles.length > 0 || ir.systems.length > 0;
  if (useLanes) {
    // bpmn-js renders lanes only inside a pool (participant), so wrap the
    // process in a participant whenever we use swimlanes. A clean generic pool
    // name reads better than a sentence fragment derived from the input.
    createParticipant(model, { name: de ? "Prozess" : "Process", processRef: model.rootProcessId });
    for (const role of ir.roles) {
      const lane = createLane(model, { name: role, parent: model.rootProcessId });
      laneByRole[role] = lane.id;
    }
    if (ir.systems.length) {
      const lane = createLane(model, { name: "System", parent: model.rootProcessId });
      laneByRole["__system__"] = lane.id;
    }
  }

  const assignLane = (nodeId: string, role?: string, system?: string): void => {
    if (!useLanes) return;
    let laneId: string | undefined;
    if (role && laneByRole[role]) laneId = laneByRole[role];
    else if (system && laneByRole["__system__"]) laneId = laneByRole["__system__"];
    else laneId = laneByRole[ir.roles[0]] ?? Object.values(laneByRole)[0];
    if (laneId) {
      model.nodes[nodeId].lane = laneId;
      const refs = model.lanes[laneId].flowNodeRefs;
      if (!refs.includes(nodeId)) refs.push(nodeId);
    }
  };

  const idMap: Record<string, string> = {}; // step.id -> created node id (primary)
  let pending: Pending[] = [];
  let currentRole: string | undefined;

  const connectPending = (toNode: string) => {
    for (const p of pending) {
      const e = createEdge(model, "sequenceFlow", p.from, toNode, {
        name: lbl(p.condition),
        condition: p.condition && !/^(yes|approved)$/i.test(p.condition) ? `\${${slug(p.condition)}}` : undefined,
        isDefault: p.isDefault,
      });
      provenance[e.id] = p.condition ? `branch: ${p.condition}` : "sequence";
    }
    pending = [];
  };

  for (const step of ir.steps) {
    currentRole = step.role ?? currentRole;
    if (step.kind === "start") {
      const n = createNode(model, "startEvent", {
        name: step.name,
        eventDefinition: eventDefFor(step),
        provenance: step.provenance,
      });
      assignLane(n.id, step.role ?? ir.roles[0], step.system);
      idMap[step.id] = n.id;
      provenance[n.id] = step.provenance;
      pending = [{ from: n.id }];
      continue;
    }
    if (step.kind === "end") {
      const n = createNode(model, "endEvent", { name: step.name, provenance: step.provenance });
      assignLane(n.id, currentRole, step.system);
      connectPending(n.id);
      idMap[step.id] = n.id;
      provenance[n.id] = step.provenance;
      continue;
    }
    if (step.kind === "approval" || step.kind === "decision") {
      buildDecision(model, step, idMap, provenance, {
        connectPending,
        getPending: () => pending,
        setPending: (p) => (pending = p),
        assignLane,
        currentRole,
        de,
        lbl,
      });
      continue;
    }
    // task / check / exception → activity
    const type = activityType(step);
    const n = createNode(model, type, { name: step.name, provenance: step.provenance });
    // service tasks belong to the System lane unless an explicit role was given
    const laneRole = type === "serviceTask" && !step.role ? undefined : (step.role ?? currentRole);
    assignLane(n.id, laneRole, step.system);
    connectPending(n.id);
    idMap[step.id] = n.id;
    provenance[n.id] = step.provenance;
    pending = [{ from: n.id }];
  }

  // Resolve loop targets: any branch with loopTo creates a back edge.
  for (const step of ir.steps) {
    for (const b of step.branches ?? []) {
      if (!b.loopTo) continue;
      const fromGw = idMap[step.id + ":gw"] ?? idMap[step.id];
      const target = idMap[b.loopTo];
      if (fromGw && target) {
        const e = createEdge(model, "sequenceFlow", fromGw, target, {
          name: lbl(b.condition),
          condition: `\${${slug(b.condition)}}`,
        });
        provenance[e.id] = `rework loop: ${b.condition}`;
      }
    }
  }

  validate(model);
  autoLayout(model, model.rootProcessId);

  const review = buildReview(ir, provenance);
  return { model, review };
}

interface BuildCtx {
  connectPending: (toNode: string) => void;
  getPending: () => Pending[];
  setPending: (p: Pending[]) => void;
  assignLane: (nodeId: string, role?: string, system?: string) => void;
  currentRole?: string;
  de: boolean;
  lbl: (t?: string) => string;
}

function buildDecision(
  model: BpmnModel,
  step: StepIR,
  idMap: Record<string, string>,
  provenance: Record<string, string>,
  ctx: BuildCtx,
): void {
  // Approval: create the approval activity first, then the gateway.
  let gatewaySource: string;
  if (step.kind === "approval") {
    const task = createNode(model, "userTask", { name: cleanApprovalName(step.name, ctx.de), provenance: step.provenance });
    ctx.assignLane(task.id, step.role ?? ctx.currentRole);
    ctx.connectPending(task.id);
    const gwName = ctx.de && /^approved\??$/i.test(step.name) ? "Freigegeben?" : step.name;
    const gw = createNode(model, "exclusiveGateway", { name: gwName, provenance: step.provenance });
    ctx.assignLane(gw.id, step.role ?? ctx.currentRole);
    createEdge(model, "sequenceFlow", task.id, gw.id);
    idMap[step.id] = task.id;
    idMap[step.id + ":gw"] = gw.id;
    gatewaySource = gw.id;
  } else {
    const gw = createNode(model, "exclusiveGateway", { name: step.name, provenance: step.provenance });
    ctx.assignLane(gw.id, step.role ?? ctx.currentRole);
    ctx.connectPending(gw.id);
    idMap[step.id] = gw.id;
    idMap[step.id + ":gw"] = gw.id;
    gatewaySource = gw.id;
  }
  provenance[gatewaySource] = step.provenance;

  const branches = step.branches ?? [];
  const positive = branches.find((b) => !/reject|no/i.test(b.condition)) ?? branches[0];
  const negative = branches.find((b) => /reject|no/i.test(b.condition));

  const newPending: Pending[] = [];
  // Positive branch continues forward (becomes pending).
  if (positive) newPending.push({ from: gatewaySource, condition: positive.condition });

  // Negative branch: loop handled later; otherwise terminate at an end event.
  if (negative && !negative.loopTo) {
    const endName = ctx.de
      ? step.kind === "approval"
        ? "Anforderung abgelehnt"
        : "Gestoppt"
      : step.kind === "approval"
        ? "Request rejected"
        : "Stopped";
    const end = createNode(model, "endEvent", { name: endName, provenance: step.provenance });
    ctx.assignLane(end.id, step.role ?? ctx.currentRole);
    const e = createEdge(model, "sequenceFlow", gatewaySource, end.id, {
      name: ctx.lbl(negative.condition),
      condition: `\${${slug(negative.condition)}}`,
    });
    provenance[e.id] = `negative branch: ${negative.condition}`;
  }
  ctx.setPending(newPending);
}

function activityType(step: StepIR): FlowElementType {
  if (step.system && !step.role) return "serviceTask";
  if (step.kind === "check" || step.role) return "userTask";
  if (step.system) return "serviceTask";
  return "task";
}

function eventDefFor(step: StepIR): EventDefinitionType | undefined {
  if (step.event && step.event !== "none") return step.event;
  if (/received|message|email|request/i.test(step.name)) return "message";
  return undefined;
}

function cleanApprovalName(name: string, de: boolean): string {
  if (de) {
    if (/^approved\??$/i.test(name)) return "Freigabe erteilen";
    return name.replace(/\?$/, "") + " freigeben";
  }
  // "Approved?" → "Approve request"; keep a verb form for the activity.
  const base = name.replace(/\?$/, "").replace(/^approved$/i, "Approve request");
  if (/^approve/i.test(base)) return base;
  return "Approve " + base.toLowerCase();
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Localize canonical branch tokens to display labels. */
const DE_LABELS: Record<string, string> = {
  approved: "freigegeben",
  rejected: "abgelehnt",
  yes: "ja",
  no: "nein",
  ok: "ok",
  incomplete: "unvollständig",
};
function labelFor(token: string | undefined, de: boolean): string {
  if (!token) return token ?? "";
  if (!de) return token;
  return DE_LABELS[token.toLowerCase()] ?? token;
}

function buildReview(ir: ProcessIR, provenance: Record<string, string>): ReviewReport {
  const de = ir.lang === "de";
  const localName = (n: string) => (de && /^approved\??$/i.test(n) ? "Freigegeben?" : n);
  const decisions = ir.steps.filter((s) => s.kind === "decision").map((s) => s.name);
  const approvals = ir.steps.filter((s) => s.kind === "approval").map((s) => localName(s.name));
  const checks = ir.steps.filter((s) => s.kind === "check").map((s) => s.name);
  const exceptions = ir.steps.filter((s) => s.kind === "exception").map((s) => s.name);
  const loops = ir.steps
    .flatMap((s) => (s.branches ?? []).filter((b) => b.loopTo).map((b) => `${s.name} → ${labelFor(b.condition, de)}`));

  const total = ir.steps.length || 1;
  const ambiguityPenalty = Math.min(0.4, ir.ambiguities.length * 0.12);
  const rolePenalty = ir.roles.length === 0 ? 0.15 : 0;
  const confidence = Math.max(0.2, Math.min(1, 1 - ambiguityPenalty - rolePenalty - (total > 30 ? 0.1 : 0)));

  return {
    roles: ir.roles,
    systems: ir.systems,
    dataObjects: ir.dataObjects,
    decisions,
    loops,
    exceptions,
    approvals,
    checks,
    assumptions: ir.assumptions,
    ambiguities: ir.ambiguities,
    provenance,
    confidence,
  };
}
