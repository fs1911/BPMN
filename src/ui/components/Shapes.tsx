import { FlowNode, isEvent, isGateway } from "@core/index";

/**
 * BPMN-accurate SVG rendering for flow nodes. Shapes, borders, type icons and
 * markers follow the BPMN 2.0 notation (thin/thick/double event rings, gateway
 * glyphs, task type icons, loop & multi-instance markers).
 */

interface ShapeProps {
  node: FlowNode;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onConnectStart: (e: React.PointerEvent) => void;
}

export function NodeShape({ node, selected, onPointerDown, onDoubleClick, onConnectStart }: ShapeProps) {
  const { x, y, width, height } = node.bounds;
  return (
    <g
      transform={`translate(${x},${y})`}
      className={`node ${selected ? "selected" : ""}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      data-id={node.id}
    >
      {renderBody(node)}
      {renderIcon(node)}
      {renderMarkers(node)}
      {renderLabel(node)}
      {selected && (
        <circle
          className="connect-handle"
          cx={width}
          cy={height / 2}
          r={5}
          onPointerDown={(e) => {
            e.stopPropagation();
            onConnectStart(e);
          }}
        />
      )}
    </g>
  );
}

function renderBody(node: FlowNode) {
  const { width: w, height: h } = node.bounds;
  if (isEvent(node.type)) {
    const r = Math.min(w, h) / 2;
    const cx = w / 2;
    const cy = h / 2;
    const thick = node.type === "endEvent";
    const dbl = node.type === "intermediateThrowEvent" || node.type === "intermediateCatchEvent" || node.type === "boundaryEvent";
    const dashed = node.type === "boundaryEvent" && node.cancelActivity === false;
    return (
      <>
        <circle className="shape event" cx={cx} cy={cy} r={r} strokeWidth={thick ? 4 : 2} strokeDasharray={dashed ? "4 3" : undefined} />
        {dbl && <circle className="shape event-inner" cx={cx} cy={cy} r={r - 3} fill="none" />}
      </>
    );
  }
  if (isGateway(node.type)) {
    const cx = w / 2;
    const cy = h / 2;
    return <polygon className="shape gateway" points={`${cx},0 ${w},${cy} ${cx},${h} 0,${cy}`} />;
  }
  if (node.type === "dataObjectReference") {
    return <path className="shape data" d={`M0,0 L${w - 12},0 L${w},12 L${w},${h} L0,${h} Z M${w - 12},0 L${w - 12},12 L${w},12`} />;
  }
  if (node.type === "dataStoreReference") {
    return (
      <path
        className="shape data"
        d={`M0,8 C0,2 ${w},2 ${w},8 L${w},${h - 6} C${w},${h} 0,${h} 0,${h - 6} Z M0,8 C0,14 ${w},14 ${w},8`}
      />
    );
  }
  if (node.type === "textAnnotation") {
    return <path className="shape annotation" d={`M10,0 L0,0 L0,${h} L10,${h}`} fill="none" />;
  }
  // activities
  return <rect className="shape activity" x={0} y={0} width={w} height={h} rx={10} ry={10} />;
}

function renderIcon(node: FlowNode) {
  const icons: Partial<Record<string, JSX.Element>> = {
    userTask: <UserIcon />,
    serviceTask: <GearIcon />,
    scriptTask: <ScriptIcon />,
    sendTask: <EnvelopeIcon filled />,
    receiveTask: <EnvelopeIcon />,
    manualTask: <HandIcon />,
    businessRuleTask: <RuleIcon />,
    callActivity: null as unknown as JSX.Element,
  };
  if (node.type.endsWith("Task") && icons[node.type]) {
    return <g transform="translate(6,6)" className="type-icon">{icons[node.type]}</g>;
  }
  if (isGateway(node.type)) return <GatewayGlyph type={node.type} w={node.bounds.width} h={node.bounds.height} />;
  if (isEvent(node.type) && node.eventDefinition && node.eventDefinition !== "none") {
    return (
      <g transform={`translate(${node.bounds.width / 2 - 8},${node.bounds.height / 2 - 8})`} className="event-icon">
        <EventGlyph kind={node.eventDefinition} />
      </g>
    );
  }
  return null;
}

function renderMarkers(node: FlowNode) {
  const m = node.markers;
  const { width: w, height: h } = node.bounds;
  const items: JSX.Element[] = [];
  let i = 0;
  const cx = w / 2;
  const push = (el: JSX.Element) => {
    items.push(
      <g key={i} transform={`translate(${cx - 18 + i * 18},${h - 18})`} className="marker">
        {el}
      </g>,
    );
    i++;
  };
  if (node.type === "subProcess" && node.collapsed) push(<rect x={2} y={2} width={12} height={12} rx={1} fill="none" stroke="currentColor" />);
  if (m?.loop) push(<path d="M2,7 A5,5 0 1 1 7,12" fill="none" stroke="currentColor" markerEnd="url(#arrow-sm)" />);
  if (m?.multiInstance === "parallel") push(<g stroke="currentColor"><line x1={3} y1={2} x2={3} y2={12} /><line x1={7} y1={2} x2={7} y2={12} /><line x1={11} y1={2} x2={11} y2={12} /></g>);
  if (m?.multiInstance === "sequential") push(<g stroke="currentColor"><line x1={2} y1={3} x2={12} y2={3} /><line x1={2} y1={7} x2={12} y2={7} /><line x1={2} y1={11} x2={12} y2={11} /></g>);
  return <>{items}</>;
}

function renderLabel(node: FlowNode) {
  if (!node.name) return null;
  const { width: w, height: h } = node.bounds;
  const inside = !isEvent(node.type) && !isGateway(node.type) && node.type !== "dataObjectReference";
  if (inside) {
    return (
      <foreignObject x={2} y={2} width={w - 4} height={h - 4} className="label-fo">
        <div className="node-label inside">{node.name}</div>
      </foreignObject>
    );
  }
  return (
    <foreignObject x={-30} y={h + 2} width={w + 60} height={40} className="label-fo">
      <div className="node-label outside">{node.name}</div>
    </foreignObject>
  );
}

// ---- glyphs ----
function GatewayGlyph({ type, w, h }: { type: string; w: number; h: number }) {
  const cx = w / 2;
  const cy = h / 2;
  if (type === "parallelGateway")
    return <path className="glyph" d={`M${cx - 12},${cy} h24 M${cx},${cy - 12} v24`} strokeWidth={3} />;
  if (type === "inclusiveGateway") return <circle className="glyph" cx={cx} cy={cy} r={10} fill="none" strokeWidth={2.5} />;
  if (type === "eventBasedGateway")
    return <polygon className="glyph" points={`${cx},${cy - 11} ${cx + 10},${cy - 3} ${cx + 6},${cy + 9} ${cx - 6},${cy + 9} ${cx - 10},${cy - 3}`} fill="none" strokeWidth={2} />;
  // exclusive: X
  return <path className="glyph" d={`M${cx - 8},${cy - 8} l16,16 M${cx + 8},${cy - 8} l-16,16`} strokeWidth={3} />;
}

function EventGlyph({ kind }: { kind: string }) {
  switch (kind) {
    case "message":
      return <g className="glyph"><rect x={0} y={2} width={16} height={12} rx={1} fill="none" /><path d="M0,2 l8,7 l8,-7" fill="none" /></g>;
    case "timer":
      return <g className="glyph"><circle cx={8} cy={8} r={7} fill="none" /><path d="M8,8 V3 M8,8 l4,2" fill="none" /></g>;
    case "error":
      return <path className="glyph" d="M2,14 l4,-9 l3,5 l5,-8" fill="none" />;
    case "signal":
      return <path className="glyph" d="M8,1 l7,13 l-14,0 Z" fill="none" />;
    case "terminate":
      return <circle className="glyph" cx={8} cy={8} r={6} />;
    case "escalation":
      return <path className="glyph" d="M8,1 l5,14 l-5,-5 l-5,5 Z" fill="none" />;
    default:
      return <circle className="glyph" cx={8} cy={8} r={6} fill="none" />;
  }
}

function UserIcon() {
  return <g className="glyph"><circle cx={6} cy={4} r={3} fill="none" /><path d="M1,13 a5,5 0 0 1 10,0" fill="none" /></g>;
}
function GearIcon() {
  return <g className="glyph"><circle cx={6} cy={6} r={3} fill="none" /><path d="M6,0 v3 M6,9 v3 M0,6 h3 M9,6 h3" /></g>;
}
function ScriptIcon() {
  return <g className="glyph"><rect x={1} y={1} width={10} height={12} fill="none" /><path d="M3,4 h6 M3,7 h6 M3,10 h4" /></g>;
}
function EnvelopeIcon({ filled }: { filled?: boolean }) {
  return <g className="glyph"><rect x={0} y={1} width={14} height={10} fill={filled ? "currentColor" : "none"} /><path d="M0,1 l7,6 l7,-6" fill="none" stroke={filled ? "var(--surface)" : "currentColor"} /></g>;
}
function HandIcon() {
  return <path className="glyph" d="M2,7 v4 h8 v-6 M4,5 v-3 M6,5 v-4 M8,5 v-3" fill="none" />;
}
function RuleIcon() {
  return <g className="glyph"><rect x={1} y={1} width={11} height={11} fill="none" /><path d="M1,4 h11 M4,4 v8" /></g>;
}
