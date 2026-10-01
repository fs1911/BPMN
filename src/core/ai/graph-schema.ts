/**
 * Graph IR — the contract between the LLM and the BPMN mapper.
 *
 * Unlike the step-list ProcessIR (which can only express a linear main path
 * with loop-back / end-early branches), this is a plain node + flow graph, so
 * alternative paths with their own activities, parallel splits/joins and
 * arbitrary merges are all expressible. The LLM fills it via structured
 * outputs; `sanitizeGraphIR` then repairs anything referentially broken before
 * `mapGraphToModel` turns it into a laid-out BpmnModel.
 *
 * This module has no imports so the edge function
 * (`netlify/edge-functions/generate.ts`) can bundle it without the engine.
 */

export const GRAPH_NODE_TYPES = [
  "startEvent",
  "endEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "task",
  "userTask",
  "serviceTask",
  "manualTask",
  "sendTask",
  "receiveTask",
  "businessRuleTask",
  "scriptTask",
  "subProcess",
  "callActivity",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_EVENT_KINDS = ["none", "message", "timer", "error", "signal", "terminate"] as const;
export type GraphEventKind = (typeof GRAPH_EVENT_KINDS)[number];

export interface GraphNodeIR {
  id: string;
  type: GraphNodeType;
  name: string;
  /** lane id, or "" when the node has no clear actor. */
  lane: string;
  event: GraphEventKind;
  /** short verbatim quote from the input that justifies this node ("" for structural nodes). */
  source: string;
}

export interface GraphFlowIR {
  from: string;
  to: string;
  /** branch label on gateway splits, "" otherwise. */
  condition: string;
  isDefault: boolean;
}

export interface GraphIR {
  title: string;
  lang: "de" | "en";
  lanes: { id: string; name: string }[];
  nodes: GraphNodeIR[];
  flows: GraphFlowIR[];
  /** external parties as black-box pools (no internal elements). */
  pools: { id: string; name: string }[];
  /** messages between an element of the process and an external pool. */
  messageFlows: { from: string; to: string; name: string }[];
  systems: string[];
  dataObjects: string[];
  assumptions: string[];
  ambiguities: { about: string; question: string; options: string[] }[];
}

/** JSON schema for structured outputs. Every field is required so the model
 * never has to guess about optional keys; "empty" is expressed as "" / []. */
export const GRAPH_IR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "lang", "lanes", "nodes", "flows", "pools", "messageFlows", "systems", "dataObjects", "assumptions", "ambiguities"],
  properties: {
    title: { type: "string" },
    lang: { type: "string", enum: ["de", "en"] },
    lanes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "name", "lane", "event", "source"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: [...GRAPH_NODE_TYPES] },
          name: { type: "string" },
          lane: { type: "string" },
          event: { type: "string", enum: [...GRAPH_EVENT_KINDS] },
          source: { type: "string" },
        },
      },
    },
    flows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "condition", "isDefault"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          condition: { type: "string" },
          isDefault: { type: "boolean" },
        },
      },
    },
    pools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    messageFlows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "name"],
        properties: { from: { type: "string" }, to: { type: "string" }, name: { type: "string" } },
      },
    },
    systems: { type: "array", items: { type: "string" } },
    dataObjects: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    ambiguities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["about", "question", "options"],
        properties: {
          about: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** Modelling rules shared by generation and editing. */
const GRAPH_RULES = `Faithfulness
- Model only what the text states or clearly implies. Do not invent activities, approvals or systems.
- Structural elements the text implies but does not name (start/end events, join gateways, an end event for a path that just stops) are fine.
- Anything you had to decide without support from the text goes into "assumptions". Anything the reader must clarify goes into "ambiguities" (with concrete answer options where possible).
- For every activity, event and split gateway, "source" is a short verbatim quote (a few words) from the input that justifies it. Use "" only for purely structural nodes such as joins.

Structure
- Exactly one start event unless the text describes several distinct triggers. Name it after the trigger ("Reklamation eingegangen"). Use event "message" for incoming requests/mails/orders, "timer" for time-based triggers.
- Every path must end in an end event. Give different outcomes their own end events with outcome names ("Ersatzgerät versendet", "Angebot abgelehnt").
- Decisions: an exclusiveGateway named as a short question ("Garantiefall?"). Each outgoing flow carries a short condition label ("ja"/"nein" or the concrete outcome). Each branch contains its own activities.
- When alternative branches continue with a common next step, merge them with an unnamed exclusiveGateway join.
- Work that happens at the same time ("gleichzeitig", "parallel", "währenddessen", "in the meantime") uses an unnamed parallelGateway split AND a matching parallelGateway join before the flow continues. Only parallel split flows have an empty condition.
- Rework ("zurück an", "erneut", "until complete") is a flow back to the earlier node where the work is redone. Flows merge only at gateways: where several flows lead into the same step (e.g. a rework loop returning), put an unnamed exclusiveGateway join directly before that step. A gateway either splits or joins, never both.
- Use inclusiveGateway only when the text says one or more of several options apply.
- Wait for an external reply/deadline: intermediateCatchEvent (event "message" or "timer").

Naming
- Activities: object + verb in the input language, 2–5 words, no actor ("Anforderung prüfen", "Ersatzgerät versenden" / "Check request"). The actor is expressed by the lane.
- Never copy sentence fragments as names. No conjunctions or clauses in names.

Lanes and types
- A lane is a role, person or department that performs at least one activity. Recipients who only receive something do not get a lane.
- Automated steps done by an IT system use serviceTask; put them in a lane named "System" (or the system's name) only if there are such steps. Human work is userTask (or manualTask for physical work like packing/shipping); sending a message to an external party is sendTask.
- If the text names no actors at all, return an empty "lanes" array and "" as each node's lane.

External parties
- Parties outside the organisation that only exchange messages with the process (customer, client, supplier, authority, "Auftraggeber") are separate pools: one entry each in "pools" (id + name, no elements inside). The organisation's own roles, departments and IT systems are lanes, never pools.
- Every message between the process and an external party is one "messageFlows" entry, named after the message ("Ausschreibung", "Offerte", "Rückfragen"): from the sending element (usually a sendTask) to the pool id, or from the pool id to the receiving element (a message start event, a message intermediateCatchEvent or a receiveTask).
- Flows inside the process are sequence flows ("flows"); flows to or from a pool are only ever message flows.
- If the text names no external party, return empty "pools" and "messageFlows".

"lang" is the language of the input ("de" or "en"); all names, conditions, assumptions and questions are in that language.`;

/** Longest process text accepted for generation (also enforced server-side). */
export const MAX_TEXT_CHARS = 30_000;

export const GRAPH_SYSTEM_PROMPT = `You turn business process descriptions (SOPs, emails, meeting notes, free prose) into a BPMN 2.0 process graph. Your output is rendered as a diagram that a process owner reviews, so it must be faithful to the text and readable.

The text may be Markdown converted from a Word or PDF document (procedure, work instruction, process description). Model only the process flow it describes. Purpose, scope, definitions, referenced documents, change history, distribution lists and similar sections are context, not steps. Responsibility tables (who does what) tell you the lanes. Text in table rows separated by "|" belongs together.

${GRAPH_RULES}

Ids: short and unique ("n1", "n2", …; lanes "l1", …).`;

export const GRAPH_EDIT_PROMPT = `You change an existing BPMN 2.0 process graph according to an instruction from its owner. You receive the current process as JSON inside <current_process> and the instruction inside <instruction>. Your output replaces the diagram after the owner reviews it.

Editing
- Return the COMPLETE updated process (all lanes, nodes and flows), not only the changes.
- Make the smallest change that fulfils the instruction. Everything the instruction does not ask to change stays exactly as it is: same id, name, type, lane, event and source.
- Never renumber or reuse ids. New elements get new ids that do not occur in the current process ("new1", "new2", …).
- Keep the process valid after the change: reconnect flows around removed elements, give new decisions all their branches, keep every path ending in an end event.
- "source": keep the existing value for existing elements; for new elements quote the relevant words of the instruction.
- "assumptions" and "ambiguities" describe only this change. If the instruction cannot be applied or is unclear, return the process unchanged and explain why in "ambiguities".
- Keep "title" and "lang" unless the instruction asks otherwise.

Apply the same modelling rules as when the process was created:

${GRAPH_RULES}`;
