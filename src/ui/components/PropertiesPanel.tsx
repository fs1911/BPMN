import { useEditor } from "@state/store";
import { BpmnModel, EventDefinitionType, FlowNode, cloneModel, isEvent } from "@core/index";

const EVENT_DEFS: EventDefinitionType[] = ["none", "message", "timer", "error", "signal", "escalation", "terminate"];

export function PropertiesPanel() {
  const model = useEditor((s) => s.model);
  const selection = useEditor((s) => s.selection);
  const store = useEditor;

  if (selection.length !== 1) {
    return (
      <div className="panel props">
        <h3>Properties</h3>
        <p className="muted">{selection.length === 0 ? "Select an element to edit its properties." : `${selection.length} elements selected.`}</p>
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
        <h3>Sequence flow</h3>
        <label>Name / condition label
          <input value={edge.name ?? ""} onChange={(e) => mutate((m) => { m.edges[id].name = e.target.value; }, "edit flow")} />
        </label>
        <label>Condition expression
          <input value={edge.condition ?? ""} placeholder="${approved}" onChange={(e) => mutate((m) => { m.edges[id].condition = e.target.value || undefined; }, "edit condition")} />
        </label>
        <label className="check">
          <input type="checkbox" checked={!!edge.isDefault} onChange={(e) => mutate((m) => { m.edges[id].isDefault = e.target.checked; }, "default flow")} /> Default flow
        </label>
        <p className="muted">{edge.isBackEdge ? "This is a back edge (rework loop) — routed in its own channel." : "Forward flow."}</p>
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
        <label>Event definition
          <select value={node.eventDefinition ?? "none"} onChange={(e) => mutate((m) => { m.nodes[id].eventDefinition = e.target.value as EventDefinitionType; }, "event def")}>
            {EVENT_DEFS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      )}

      {(node.type.endsWith("Task") || node.type === "subProcess" || node.type === "callActivity") && (
        <fieldset>
          <legend>Markers</legend>
          <label className="check"><input type="checkbox" checked={!!node.markers?.loop} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, loop: e.target.checked }; }, "loop marker")} /> Loop</label>
          <label className="check"><input type="checkbox" checked={node.markers?.multiInstance === "parallel"} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, multiInstance: e.target.checked ? "parallel" : false }; }, "MI marker")} /> Multi-instance (parallel)</label>
          <label className="check"><input type="checkbox" checked={node.markers?.multiInstance === "sequential"} onChange={(e) => mutate((m) => { m.nodes[id].markers = { ...m.nodes[id].markers, multiInstance: e.target.checked ? "sequential" : false }; }, "MI marker")} /> Multi-instance (sequential)</label>
        </fieldset>
      )}

      {node.type === "subProcess" && (
        <label className="check"><input type="checkbox" checked={!!node.collapsed} onChange={(e) => mutate((m) => { m.nodes[id].collapsed = e.target.checked; }, "collapse")} /> Collapsed</label>
      )}

      {node.type === "callActivity" && (
        <label>Called element
          <input value={node.calledElement ?? ""} onChange={(e) => mutate((m) => { m.nodes[id].calledElement = e.target.value || undefined; }, "called element")} />
        </label>
      )}

      <label>Documentation
        <textarea value={node.documentation ?? ""} rows={3} onChange={(e) => mutate((m) => { m.nodes[id].documentation = e.target.value || undefined; }, "doc")} />
      </label>

      {node.provenance && <p className="muted">From: “{node.provenance}”</p>}

      <button className="danger" onClick={() => store.getState().deleteSelection()}>Delete</button>
    </div>
  );
}

function prettyType(t: FlowNode["type"]): string {
  return t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
