import { FlowElementType } from "@core/index";
import { useEditor } from "@state/store";

const GROUPS: Array<{ title: string; items: Array<{ type: FlowElementType; label: string; ed?: string }> }> = [
  {
    title: "Events",
    items: [
      { type: "startEvent", label: "Start" },
      { type: "intermediateCatchEvent", label: "Intermediate" },
      { type: "boundaryEvent", label: "Boundary" },
      { type: "endEvent", label: "End" },
    ],
  },
  {
    title: "Activities",
    items: [
      { type: "task", label: "Task" },
      { type: "userTask", label: "User task" },
      { type: "serviceTask", label: "Service task" },
      { type: "subProcess", label: "Sub-process" },
      { type: "callActivity", label: "Call activity" },
    ],
  },
  {
    title: "Gateways",
    items: [
      { type: "exclusiveGateway", label: "Exclusive (XOR)" },
      { type: "parallelGateway", label: "Parallel (AND)" },
      { type: "inclusiveGateway", label: "Inclusive (OR)" },
      { type: "eventBasedGateway", label: "Event-based" },
    ],
  },
  {
    title: "Data",
    items: [
      { type: "dataObjectReference", label: "Data object" },
      { type: "dataStoreReference", label: "Data store" },
      { type: "textAnnotation", label: "Annotation" },
    ],
  },
];

export function Palette() {
  const addNode = useEditor((s) => s.addNode);
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);

  const place = (type: FlowElementType) => {
    // place near the visible center of the canvas
    const cx = (window.innerWidth / 2 - 260 - pan.x) / zoom;
    const cy = (window.innerHeight / 2 - pan.y) / zoom;
    addNode(type, { x: cx + (Math.random() * 40 - 20), y: cy + (Math.random() * 40 - 20) });
  };

  return (
    <div className="palette">
      {GROUPS.map((g) => (
        <div key={g.title} className="palette-group">
          <div className="palette-title">{g.title}</div>
          <div className="palette-items">
            {g.items.map((it) => (
              <button key={it.type} className="palette-item" title={`Add ${it.label}`} onClick={() => place(it.type)}>
                <PaletteIcon type={it.type} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PaletteIcon({ type }: { type: FlowElementType }) {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" className="palette-icon">
      {renderMini(type)}
    </svg>
  );
}

function renderMini(type: FlowElementType) {
  if (type.endsWith("Event")) {
    const thick = type === "endEvent" ? 2.5 : 1.3;
    const dbl = type === "intermediateCatchEvent" || type === "boundaryEvent";
    return (
      <>
        <circle cx={13} cy={13} r={9} fill="none" stroke="currentColor" strokeWidth={thick} />
        {dbl && <circle cx={13} cy={13} r={6} fill="none" stroke="currentColor" strokeWidth={1} />}
      </>
    );
  }
  if (type.endsWith("Gateway")) {
    const glyph =
      type === "parallelGateway" ? "M8,13 h10 M13,8 v10" : type === "exclusiveGateway" ? "M9,9 l8,8 M17,9 l-8,8" : "";
    return (
      <>
        <polygon points="13,2 24,13 13,24 2,13" fill="none" stroke="currentColor" strokeWidth={1.3} />
        {glyph && <path d={glyph} stroke="currentColor" strokeWidth={1.6} fill="none" />}
        {type === "inclusiveGateway" && <circle cx={13} cy={13} r={5} fill="none" stroke="currentColor" strokeWidth={1.6} />}
      </>
    );
  }
  if (type === "dataObjectReference") return <path d="M6,3 h9 l4,4 v16 h-13 Z" fill="none" stroke="currentColor" strokeWidth={1.3} />;
  if (type === "dataStoreReference") return <path d="M4,7 c0,-3 18,-3 18,0 v12 c0,3 -18,3 -18,0 Z" fill="none" stroke="currentColor" strokeWidth={1.3} />;
  if (type === "textAnnotation") return <path d="M9,3 h-6 v20 h6" fill="none" stroke="currentColor" strokeWidth={1.3} />;
  return <rect x={3} y={6} width={20} height={14} rx={3} fill="none" stroke="currentColor" strokeWidth={1.3} />;
}
