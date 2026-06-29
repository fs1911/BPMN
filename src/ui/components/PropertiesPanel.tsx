import { useEditor } from "@state/store";
import { BpmnModel, EventDefinitionType, FlowNode, cloneModel, isEvent } from "@core/index";

const EVENT_DEFS: EventDefinitionType[] = ["none", "message", "timer", "error", "signal", "escalation", "terminate"];

const EVENT_LABELS: Record<string, string> = {
  none: "ohne",
  message: "Nachricht",
  timer: "Zeit",
  error: "Fehler",
  signal: "Signal",
  escalation: "Eskalation",
  terminate: "Abbruch",
};

const TYPE_LABELS: Record<string, string> = {
  startEvent: "Startereignis",
  endEvent: "Endereignis",
  intermediateThrowEvent: "Zwischenereignis (werfend)",
  intermediateCatchEvent: "Zwischenereignis (fangend)",
  boundaryEvent: "Rand-Ereignis",
  task: "Aufgabe",
  userTask: "Benutzeraufgabe",
  serviceTask: "Serviceaufgabe",
  scriptTask: "Skriptaufgabe",
  sendTask: "Sendeaufgabe",
  receiveTask: "Empfangsaufgabe",
  manualTask: "Manuelle Aufgabe",
  businessRuleTask: "Geschäftsregel-Aufgabe",
  subProcess: "Teilprozess",
  callActivity: "Aufruf-Aktivität",
  exclusiveGateway: "Exklusives Gateway (XOR)",
  parallelGateway: "Paralleles Gateway (UND)",
  inclusiveGateway: "Inklusives Gateway (ODER)",
  eventBasedGateway: "Ereignisbasiertes Gateway",
  complexGateway: "Komplexes Gateway",
  dataObjectReference: "Datenobjekt",
  dataStoreReference: "Datenspeicher",
  textAnnotation: "Anmerkung",
};

export function PropertiesPanel() {
  const model = useEditor((s) => s.model);
  const selection = useEditor((s) => s.selection);
  const store = useEditor;

  if (selection.length !== 1) {
    return (
      <div className="panel props">
        <h3>Eigenschaften</h3>
        <p className="muted">{selection.length === 0 ? "Wählen Sie ein Element, um seine Eigenschaften zu bearbeiten." : `${selection.length} Elemente ausgewählt.`}</p>
      </div>
    );
  }
  const id = selection[0];
  const node = model.nodes[id];
  const edge = model.edges[id];

  const mutate = (fn: (m: BpmnModel) => void, label: string) => {
    const m = cloneModel(model);
    fn(m);
    store.getState().setModel(m, label);
  };

  if (edge) {
    return (
      <div className="panel props">
        <h3>Sequenzfluss</h3>
        <label>Name / Bedingungsbeschriftung
          <input value={edge.name ?? ""} onChange={(e) => mutate((m) => { m.edges[id].name = e.target.value; }, "Fluss bearbeiten")} />
        </label>
        <label>Bedingungsausdruck
          <input value={edge.condition ?? ""} placeholder="${freigegeben}" onChange={(e) => mutate((m) => { m.edges[id].condition = e.target.value || undefined; }, "Bedingung bearbeiten")} />
        </label>
        <label className="check">
          <input type="checkbox" checked={!!edge.isDefault} onChange={(e) => mutate((m) => { m.edges[id].isDefault = e.target.checked; }, "Standardfluss")} /> Standardfluss
        </label>
        <p className="muted">{edge.isBackEdge ? "Dies ist eine Rückwärtskante (Nachbearbeitungsschleife) – in einem eigenen Kanal verlegt." : "Vorwärtsfluss."}</p>
      </div>
    );
  }

  if (!node) return <div className="panel props"><h3>Properties</h3></div>;

  return (
    <div className="panel props">
      <h3>{prettyType(node.type)}</h3>
      <label>Name
        <input value={node.name ?? ""} onChange={(e) => store.getState().setNodeName(id, e.target.value)} onBlur={(e) => store.getState().renameNode(id, e.target.value)} />
      </label>

      {isEvent(node.type) && (
        <label>Ereignisdefinition
          <select value={node.eventDefinition ?? "none"} onChange={(e) => mutate((m) => { m.nodes[id].eventDefinition = e.target.value as EventDefinitionType; }, "Ereignisdefinition")}>
            {EVENT_DEFS.map((d) => <option key={d} value={d}>{EVENT_LABELS[d]}</option>)}
          </select>
        </label>
      )}

      {(node.type.endsWith("Task") || node.type === "subProcess" || node.type === "callActivity") && (
        <fieldset>
          <legend>Marker</legend>
          <label className="check"><input type="checkbox" checked={!!node.markers?.loop} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, loop: e.target.checked }; }, "Schleifen-Marker")} /> Schleife</label>
          <label className="check"><input type="checkbox" checked={node.markers?.multiInstance === "parallel"} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, multiInstance: e.target.checked ? "parallel" : false }; }, "MI-Marker")} /> Mehrfachinstanz (parallel)</label>
          <label className="check"><input type="checkbox" checked={node.markers?.multiInstance === "sequential"} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, multiInstance: e.target.checked ? "sequential" : false }; }, "MI-Marker")} /> Mehrfachinstanz (sequenziell)</label>
        </fieldset>
      )}

      {node.type === "subProcess" && (
        <label className="check"><input type="checkbox" checked={!!node.collapsed} onChange={(e) => mutate((m) => { m.nodes[id].collapsed = e.target.checked; }, "Einklappen")} /> Eingeklappt</label>
      )}

      {node.type === "callActivity" && (
        <label>Aufgerufenes Element
          <input value={node.calledElement ?? ""} onChange={(e) => mutate((m) => { m.nodes[id].calledElement = e.target.value || undefined; }, "Aufgerufenes Element")} />
        </label>
      )}

      <label>Dokumentation
        <textarea value={node.documentation ?? ""} rows={3} onChange={(e) => mutate((m) => { m.nodes[id].documentation = e.target.value || undefined; }, "Dokumentation")} />
      </label>

      {node.provenance && <p className="muted">Aus: „{node.provenance}“</p>}

      <button className="danger" onClick={() => store.getState().deleteSelection()}>Löschen</button>
    </div>
  );
}

function prettyType(t: FlowNode["type"]): string {
  return TYPE_LABELS[t] ?? t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
