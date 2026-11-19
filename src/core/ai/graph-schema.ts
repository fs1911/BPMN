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
  "boundaryEvent",
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

export const GRAPH_EVENT_KINDS = ["none", "message", "timer", "error", "signal", "conditional", "escalation", "terminate"] as const;
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
  /** boundaryEvent: id of the activity it sits on ("" for every other node). */
  attachedTo: string;
  /** boundaryEvent: whether it stops the activity (true for every other node). */
  interrupting: boolean;
  /** IT systems / programs this step is done in or writes to (names as in "systems"); [] if none */
  systems: string[];
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
  /** process profile, if the text states it ("" otherwise) */
  purpose: string;
  scope: string;
  owner: string;
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
  /** elements: ids of the nodes a question is about ([] if it concerns the whole process) */
  ambiguities: { about: string; question: string; options: string[]; elements: string[] }[];
  /** suggestions to improve or automate the process — never built into the graph (optional for older data) */
  improvements?: GraphImprovement[];
}

export const IMPROVEMENT_KINDS = ["optimierung", "automatisierung", "best-practice"] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];
export interface GraphImprovement {
  kind: ImprovementKind;
  title: string;
  /** what to change and why (benefit) */
  description: string;
  /** ids of the nodes concerned ([] = whole process) */
  elements: string[];
}

/** JSON schema for structured outputs. Every field is required so the model
 * never has to guess about optional keys; "empty" is expressed as "" / []. */
export const GRAPH_IR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "purpose", "scope", "owner", "lang", "lanes", "nodes", "flows", "pools", "messageFlows", "systems", "dataObjects", "assumptions", "ambiguities", "improvements"],
  properties: {
    title: { type: "string" },
    purpose: { type: "string" },
    scope: { type: "string" },
    owner: { type: "string" },
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
        required: ["id", "type", "name", "lane", "event", "source", "attachedTo", "interrupting", "systems"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: [...GRAPH_NODE_TYPES] },
          name: { type: "string" },
          lane: { type: "string" },
          event: { type: "string", enum: [...GRAPH_EVENT_KINDS] },
          source: { type: "string" },
          attachedTo: { type: "string" },
          interrupting: { type: "boolean" },
          systems: { type: "array", items: { type: "string" } },
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
        required: ["about", "question", "options", "elements"],
        properties: {
          about: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          elements: { type: "array", items: { type: "string" } },
        },
      },
    },
    improvements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "description", "elements"],
        properties: {
          kind: { type: "string", enum: [...IMPROVEMENT_KINDS] },
          title: { type: "string" },
          description: { type: "string" },
          elements: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** Modelling rules shared by generation and editing. */
const GRAPH_RULES = `Faithfulness
- Model only what the text states or clearly implies. Do not invent activities, approvals or systems.
- Structural elements the text implies but does not name (start/end events, join gateways, an end event for a path that just stops) are fine.
- Anything you had to decide without support from the text goes into "assumptions". Anything the reader must clarify goes into "ambiguities" (with concrete answer options where possible); its "elements" lists the ids of the nodes the question is about, so the reader can be shown the spot in the diagram ([] only if it concerns the whole process). In "assumptions", name the affected elements with their exact names in quotes („…“).
- For every activity, event and split gateway, "source" is a short verbatim quote (a few words) from the input that justifies it. Use "" only for purely structural nodes such as joins.

Structure
- Exactly one start event unless the text describes several distinct triggers. Name it after the trigger ("Reklamation eingegangen"). Use event "message" for incoming requests/mails/orders, "timer" for time-based triggers.
- Every path must end in an end event; a process with a start event has at least one end event. Give different outcomes their own end events with outcome names ("Ersatzgerät versendet", "Angebot abgelehnt").
- Decisions: an exclusiveGateway named as a short question ("Garantiefall?"). Each outgoing flow carries a short condition label ("ja"/"nein" or the concrete outcome). Each branch contains its own activities.
- When alternative branches continue with a common next step, merge them with an unnamed exclusiveGateway join.
- Work that happens at the same time ("gleichzeitig", "parallel", "währenddessen", "in the meantime") uses an unnamed parallelGateway split AND a matching parallelGateway join before the flow continues. Only parallel split flows have an empty condition.
- Rework ("zurück an", "erneut", "until complete") is a flow back to the earlier node where the work is redone. Flows merge only at gateways: where several flows lead into the same step (e.g. a rework loop returning), put an unnamed exclusiveGateway join directly before that step. A gateway either splits or joins, never both.
- Rework jumps back only as far as the work that is really redone. Do not jump back in front of a parallelGateway split unless every parallel branch must run again (that repeats orders, plans, …); if the text says so, note it in "assumptions".
- Use inclusiveGateway only when the text says one or more of several options apply. Split: each option is a flow with its condition; if "none of them" is possible, add a default flow (isDefault: true) for that case. Join the branches with a matching unnamed inclusiveGateway.
- A default flow (isDefault: true) only leaves an exclusiveGateway or inclusiveGateway, at most one per gateway, for the "otherwise" case.
- Wait for an external reply/deadline in the flow: intermediateCatchEvent (event "message", "timer", "signal" or "conditional") with exactly one incoming and one outgoing flow.
- Waiting for whichever of several events comes first: eventBasedGateway with at least two outgoing flows WITHOUT conditions, each leading directly to an intermediateCatchEvent (message, timer, signal or conditional) that has no other incoming flow.

Exceptions during an activity (ISO/IEC 19510, 10.5.4)
- Something that happens WHILE an activity runs (a report, a deadline, an error, a cancellation) is a boundaryEvent: "attachedTo" = id of that activity, "lane" = its lane, "event" = message / timer / error / signal / conditional / escalation (never "none" or "terminate").
- "interrupting": true stops the activity (the exception path replaces it). false lets it continue in parallel — only for message, timer, signal, conditional and escalation; error is always interrupting.
- A boundaryEvent never has an incoming flow and has at least one outgoing flow: the exception path, which ends in an end event or leads back into the process (e.g. back to the interrupted activity to restart it).
- Errors appear only as boundaryEvent or as endEvent with event "error", never as an event in the middle of the flow.
- For every other node "attachedTo" is "" and "interrupting" is true.

Naming
- Activities: object + verb in the input language, 2–5 words, no actor ("Anforderung prüfen", "Ersatzgerät versenden" / "Check request"). The actor is expressed by the lane.
- Never copy sentence fragments as names. No conjunctions or clauses in names.

Lanes and types
- A lane is a role, person or department that performs at least one activity. Recipients who only receive something do not get a lane.
- IT systems and programs the text names (ERP, accounting, document management, construction software, e.g. "Abacus", "DocuWare", "SAP", "Sorba", "A3") go into "systems" with their exact name. For every step done in, or writing to, such a system, list it in that node's "systems" (the diagram shows it as a data store next to the step); [] otherwise. A step done by a person IN a system stays a userTask in that person's lane. Systems are never lanes for human work.
- Automated steps done by an IT system use serviceTask; put them in a lane named "System" (or the system's name) only if there are such steps. Human work is userTask (or manualTask for physical work like packing/shipping); sending a message to an external party is sendTask.
- If the text names no actors at all, return an empty "lanes" array and "" as each node's lane.

External parties
- Parties outside the organisation that only exchange messages with the process (customer, client, supplier, authority, "Auftraggeber") are separate pools: one entry each in "pools" (id + name, no elements inside). The organisation's own roles, departments and IT systems are lanes, never pools.
- Every message between the process and an external party is one "messageFlows" entry, named after the message ("Ausschreibung", "Offerte", "Rückfragen"): from the sending element (usually a sendTask) to the pool id, or from the pool id to the receiving element (a message start event, a message intermediateCatchEvent or a receiveTask).
- Flows inside the process are sequence flows ("flows"); flows to or from a pool are only ever message flows.
- If the text names no external party, return empty "pools" and "messageFlows".

Readable layout (the diagram is laid out automatically from your graph; crossing lines make it hard to read)
- Keep the main path (happy path) one straight chain from start to end; exceptions and rejections branch off it and end early or rejoin.
- List "lanes" in the order the work moves through them (the role that starts first on top), so most flows go down or stay in their lane, and roles that hand over work to each other are neighbours.
- Rework loops go back only to the nearest step that is really redone (short loops, see Structure).
- Do not route several unrelated paths through one gateway; one gateway per decision.

Best practice (B. Silver, "BPMN Method and Style"; Freund & Rücker, "Praxishandbuch BPMN")
- Start and end events are named with a state ("Rechnung eingegangen", "Rechnung bezahlt"); one end event per distinct outcome.
- Gateways split with a question and labelled outcomes; joins are unnamed. No implicit splits or merges through activities.
- Activities are "object + verb"; one activity = one unit of work by one role.
- Lanes are roles, never systems that do human work; external parties are pools connected only by message flows.

Improvements ("improvements") — suggestions only, never built into the graph
- The graph shows the process as described. Do NOT change it to apply your suggestions; the owner decides each one.
- Suggest at most 6, only where the text gives a concrete reason, each with "elements" = ids of the nodes concerned:
  - "optimierung": remove waiting, duplicate checks, media breaks (print/scan/re-type), unnecessary hand-offs between lanes, avoidable rework loops, steps that can run in parallel.
  - "automatisierung": a manual step that a named system could do (e.g. automatic invoice capture in DocuWare, automatic posting or reminders in Abacus, rule-based approval below a threshold) → would become a serviceTask; name the system and the benefit.
  - "best-practice": a modelling or control weakness (missing outcome for a decision, missing deadline/escalation for an external reply, missing four-eyes principle where money is released).
- "description": one or two sentences: what to change and the benefit. "title": short imperative ("Rechnungseingang automatisieren"). [] if there is nothing worth suggesting.

Process profile: "purpose" (Zweck), "scope" (Geltungsbereich: where/for whom it applies) and "owner" (Prozesseigner / Zuständigkeit: the role or unit responsible for the process) — one short sentence each, taken from the text if it states them; "" if it does not (never invent them). "title" names the process ("Kreditoren verarbeiten"), never "Start" or a heading word.

"lang" is the language of the input ("de" or "en"); all names, conditions, assumptions and questions are in that language.`;

/** An image of the process (photo, scanned page, drawn flowchart), base64 without the data: prefix. */
export interface ProcessImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string;
}
/** Images per generation (also enforced server-side). */
export const MAX_IMAGES = 5;
/**
 * base64 characters per image (~240 KB JPEG). Keeps a request with every
 * image under ~1.6 MB: the server parses and re-serialises it within the
 * CPU budget of a free Cloudflare Worker.
 */
export const MAX_IMAGE_CHARS = 320_000;

/** Longest process text accepted for generation (also enforced server-side). */
export const MAX_TEXT_CHARS = 30_000;
/** Longest edit instruction (several answered questions fit). */
export const MAX_INSTRUCTION_CHARS = 6_000;

export const GRAPH_SYSTEM_PROMPT = `You turn business process descriptions (SOPs, emails, meeting notes, free prose) into a BPMN 2.0 process graph. Your output is rendered as a diagram that a process owner reviews, so it must be faithful to the text and readable.

The input may include images: photos of whiteboards or handwritten notes, scanned pages, pages of a document, or an existing flowchart or process diagram in any notation. Read them like text and model the process they show; text and images describe the same process. Arrows, boxes and swimlanes in a drawn diagram are strong hints for flows, steps and lanes, but apply the modelling rules below rather than copying a faulty drawing. For elements taken from an image, "source" quotes the words written there ("" if there are none). Never guess unreadable parts: put them into "ambiguities".

A section "Ablaufzeichnung … aus dem Word-Dokument" is a flowchart read from shapes and arrows in the document: its flow is exact. Model every shape and every arrow as listed — a shape marked "(Entscheidung)" is an exclusiveGateway named with its question, and the arrow labels are its conditions; shapes marked "(Start/Ende)" are the start and end events. Do not add, drop or reorder steps of a drawing. Take the actor of a step from its wording ("Buchhaltung storniert RG" → lane Buchhaltung; "Visumsverantwortlicher …" → lane Visumsverantwortlicher) and write the name without the actor ("RG stornieren"). Several drawings in one document are usually consecutive parts or sub-processes of one process: connect them in the order of the document unless the text says otherwise, and say what you did in "assumptions".

The text may be Markdown converted from a Word or PDF document (procedure, work instruction, process description). Model only the process flow it describes. Purpose, scope, definitions, referenced documents, change history, distribution lists and similar sections are context, not steps. Responsibility tables (who does what) tell you the lanes. Text in table rows separated by "|" belongs together.

If a <focus> block is present, the text describes several processes and the owner chose one of them: model ONLY the process named in <focus>. Where it hands over to or is triggered by one of the other processes, use a message or signal event (or a pool for an external party) named after that other process instead of modelling its steps, and note it in "assumptions". "title", "purpose", "scope" and "owner" describe THIS process, not the whole document: if the text states them only for the whole procedure, narrow them to the chosen process (e.g. purpose of the payment run instead of the purpose of accounts payable) and say so in "assumptions"; "" where nothing fits.

${GRAPH_RULES}

Ids: short and unique ("n1", "n2", …; lanes "l1", …).`;

export const GRAPH_EDIT_PROMPT = `You change an existing BPMN 2.0 process graph according to an instruction from its owner. You receive the current process as JSON inside <current_process> and the instruction inside <instruction>. Your output replaces the diagram after the owner reviews it.

Editing
- Return the COMPLETE updated process (all lanes, nodes and flows), not only the changes.
- Make the smallest change that fulfils the instruction. Everything the instruction does not ask to change stays exactly as it is: same id, name, type, lane, event and source.
- Never renumber or reuse ids. New elements get new ids that do not occur in the current process ("new1", "new2", …).
- Keep the process valid after the change: reconnect flows around removed elements, give new decisions all their branches, keep every path ending in an end event.
- "source": keep the existing value for existing elements; for new elements quote the relevant words of the instruction.
- "assumptions", "ambiguities" and "improvements" describe only this change ("improvements" usually []). If the instruction cannot be applied or is unclear, return the process unchanged and explain why in "ambiguities".
- Keep "title" and "lang" unless the instruction asks otherwise.
- The instruction may answer earlier open questions. Treat the owner's answers as facts: model them, and do not ask about these points again.

Apply the same modelling rules as when the process was created:

${GRAPH_RULES}`;

/** Upper limit for the chosen process in a scope choice. */
export const MAX_FOCUS_CHARS = 600;

/** Answer of the scope check: which separate processes the text describes. */
export interface ScopeProcess {
  title: string;
  /** what starts it */
  trigger: string;
  summary: string;
}
export interface ScopeResult {
  processes: ScopeProcess[];
  /** how the processes relate (handover, independent, …), one sentence */
  relation: string;
}

export const SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["processes", "relation"],
  properties: {
    processes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "trigger", "summary"],
        properties: { title: { type: "string" }, trigger: { type: "string" }, summary: { type: "string" } },
      },
    },
    relation: { type: "string" },
  },
} as const;

export const SCOPE_PROMPT = `You check a business process description (inside <process_description>) BEFORE it is turned into a BPMN diagram: does it describe one process or several separate processes?

Several processes means: separate flows that each have their own trigger and their own outcome and could be owned, run and improved independently (e.g. "Rechnung erfassen und visieren", "Zahlungslauf", "Mahnwesen" in one finance procedure). A trigger is an event, a date/period or a request.
One process means: one flow, even with branches, exceptions, loops, parallel work, several start triggers that lead into the same flow, or sub-steps another role does.

Return every separate process in the order of the text: "title" (object + verb, 2–5 words, in the language of the text), "trigger" (what starts it, a few words), "summary" (one sentence: what happens until it ends). If it is one process, return exactly one entry. "relation": one sentence on how the processes are connected (handover, run independently, one triggers the other), "" for one process.`;
