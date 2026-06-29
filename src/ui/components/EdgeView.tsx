import { Edge } from "@core/index";

interface EdgeProps {
  edge: Edge;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

export function EdgeView({ edge, selected, onPointerDown }: EdgeProps) {
  const wps = edge.waypoints ?? [];
  if (wps.length < 2) return null;
  const d = wps.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const mid = wps[Math.floor(wps.length / 2)];
  const dashed = edge.type === "messageFlow" || edge.type === "association";
  const marker = edge.type === "messageFlow" ? "url(#msg-end)" : edge.type === "association" ? undefined : "url(#seq-end)";
  const startMarker = edge.type === "messageFlow" ? "url(#msg-start)" : undefined;
  return (
    <g className={`edge ${edge.type} ${edge.isBackEdge ? "back-edge" : ""} ${selected ? "selected" : ""}`} onPointerDown={onPointerDown} data-id={edge.id}>
      <path className="edge-hit" d={d} fill="none" />
      <path
        className="edge-line"
        d={d}
        fill="none"
        strokeDasharray={dashed ? "6 5" : undefined}
        markerEnd={marker}
        markerStart={startMarker}
      />
      {edge.isDefault && <DefaultSlash wps={wps} />}
      {edge.name && (
        <foreignObject x={mid.x - 50} y={mid.y - 22} width={100} height={20} className="edge-label-fo">
          <div className="edge-label">{edge.name}</div>
        </foreignObject>
      )}
    </g>
  );
}

function DefaultSlash({ wps }: { wps: { x: number; y: number }[] }) {
  const a = wps[0];
  const b = wps[1];
  const t = 0.25;
  const cx = a.x + (b.x - a.x) * t;
  const cy = a.y + (b.y - a.y) * t;
  return <path className="default-slash" d={`M${cx - 5},${cy + 5} l10,-10`} />;
}
