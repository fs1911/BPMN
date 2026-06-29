import { useRef, useState } from "react";
import { useEditor } from "@state/store";
import { NodeShape } from "./Shapes";
import { EdgeView } from "./EdgeView";

/**
 * Interactive SVG modeling canvas: pan, zoom-to-cursor, grid, snap, marquee
 * select, multi-select, shape drag with live re-routing, and quick-connect via
 * the connection handle. Pointer-capture based interaction keeps drags smooth.
 */
export function Canvas() {
  const model = useEditor((s) => s.model);
  const selection = useEditor((s) => s.selection);
  const zoom = useEditor((s) => s.zoom);
  const pan = useEditor((s) => s.pan);
  const grid = useEditor((s) => s.grid);
  const connectFrom = useEditor((s) => s.connectFrom);
  const store = useEditor;

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ mode: "none" | "move" | "pan" | "marquee" | "connect"; sx: number; sy: number; lastWX: number; lastWY: number; from?: string }>({
    mode: "none",
    sx: 0,
    sy: 0,
    lastWX: 0,
    lastWY: 0,
  });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [tempLine, setTempLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    store.getState().zoomBy(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && (e.target as Element).tagName !== "rect") {
      // allow marquee only from blank areas / grid rect
    }
    const w = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || e.shiftKey || e.button === 2) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, lastWX: w.x, lastWY: w.y };
    } else {
      drag.current = { mode: "marquee", sx: w.x, sy: w.y, lastWX: w.x, lastWY: w.y };
      setMarquee({ x: w.x, y: w.y, w: 0, h: 0 });
      store.getState().clearSelection();
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onNodePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const st = store.getState();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!st.selection.includes(id)) st.select([id], additive);
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, lastWX: w.x, lastWY: w.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onConnectStart = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    const node = model.nodes[id];
    const from = { x: node.bounds.x + node.bounds.width, y: node.bounds.y + node.bounds.height / 2 };
    drag.current = { mode: "connect", sx: e.clientX, sy: e.clientY, lastWX: w.x, lastWY: w.y, from: id };
    store.getState().startConnect(id);
    setTempLine({ x1: from.x, y1: from.y, x2: w.x, y2: w.y });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.mode === "none") return;
    const w = toWorld(e.clientX, e.clientY);
    if (d.mode === "pan") {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      d.sx = e.clientX;
      d.sy = e.clientY;
      const p = store.getState().pan;
      store.getState().setPan({ x: p.x + dx, y: p.y + dy });
    } else if (d.mode === "move") {
      const ddx = w.x - d.lastWX;
      const ddy = w.y - d.lastWY;
      d.lastWX = w.x;
      d.lastWY = w.y;
      store.getState().moveSelection(ddx, ddy, false);
    } else if (d.mode === "marquee") {
      setMarquee({ x: Math.min(d.sx, w.x), y: Math.min(d.sy, w.y), w: Math.abs(w.x - d.sx), h: Math.abs(w.y - d.sy) });
    } else if (d.mode === "connect") {
      setTempLine((t) => (t ? { ...t, x2: w.x, y2: w.y } : t));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.mode === "move") {
      store.getState().moveSelection(0, 0, true);
    } else if (d.mode === "marquee" && marquee) {
      const ids = Object.values(model.nodes)
        .filter((n) => n.parent === store.getState().scope)
        .filter((n) => rectContains(marquee, n.bounds))
        .map((n) => n.id);
      if (ids.length) store.getState().select(ids);
      setMarquee(null);
    } else if (d.mode === "connect" && d.from) {
      const target = nodeUnderPointer(e.clientX, e.clientY);
      if (target && target !== d.from) store.getState().connect(d.from, target);
      else store.getState().startConnect(undefined);
      setTempLine(null);
    }
    drag.current.mode = "none";
  };

  const nodes = Object.values(model.nodes).filter((n) => n.parent === store.getState().scope);
  const lanes = Object.values(model.lanes);
  const edges = Object.values(model.edges);

  return (
    <svg
      ref={svgRef}
      className="canvas"
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <marker id="seq-end" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" className="arrow" />
        </marker>
        <marker id="msg-end" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto">
          <path d="M0,0 L9,5 L0,10 z" className="arrow-open" />
        </marker>
        <marker id="msg-start" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
          <circle cx="5" cy="5" r="3" className="arrow-open" />
        </marker>
        <marker id="arrow-sm" markerWidth="6" markerHeight="6" refX="4" refY="2" orient="auto">
          <path d="M0,0 L4,2 L0,4 z" className="arrow" />
        </marker>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20,0 L0,0 L0,20" fill="none" className="grid-line" />
        </pattern>
      </defs>

      <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
        <rect className="bg" x={-5000} y={-5000} width={10000} height={10000} fill={grid ? "url(#grid)" : "transparent"} />

        {lanes.map((l) => (
          <g key={l.id} className="lane">
            <rect x={l.bounds.x} y={l.bounds.y} width={l.bounds.width} height={l.bounds.height} className="lane-rect" />
            <text x={l.bounds.x + 14} y={l.bounds.y + l.bounds.height / 2} className="lane-label" transform={`rotate(-90 ${l.bounds.x + 14} ${l.bounds.y + l.bounds.height / 2})`}>
              {l.name}
            </text>
          </g>
        ))}

        {edges.map((e) => (
          <EdgeView
            key={e.id}
            edge={e}
            selected={selection.includes(e.id)}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              store.getState().select([e.id], ev.shiftKey);
            }}
          />
        ))}

        {nodes.map((n) => (
          <NodeShape
            key={n.id}
            node={n}
            selected={selection.includes(n.id)}
            onPointerDown={onNodePointerDown(n.id)}
            onDoubleClick={() => {
              const name = prompt("Beschriftung", n.name ?? "");
              if (name !== null) store.getState().renameNode(n.id, name);
            }}
            onConnectStart={onConnectStart(n.id)}
          />
        ))}

        {tempLine && <line className="temp-connect" x1={tempLine.x1} y1={tempLine.y1} x2={tempLine.x2} y2={tempLine.y2} />}
        {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
      </g>

      {connectFrom && <text className="hint" x={12} y={24}>Verbinden… Zielelement anklicken</text>}
    </svg>
  );
}

function rectContains(box: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; width: number; height: number }) {
  return b.x >= box.x && b.y >= box.y && b.x + b.width <= box.x + box.w && b.y + b.height <= box.y + box.h;
}

function nodeUnderPointer(clientX: number, clientY: number): string | undefined {
  const el = document.elementFromPoint(clientX, clientY);
  let cur: Element | null = el;
  while (cur) {
    const id = cur.getAttribute?.("data-id");
    if (id) return id;
    cur = cur.parentElement;
  }
  return undefined;
}
