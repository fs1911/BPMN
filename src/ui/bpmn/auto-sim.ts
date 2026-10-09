import type Modeler from "bpmn-js/lib/Modeler";
import type { Scenario } from "@core/index";

/**
 * Plays scenarios (from enumerateScenarios) on the canvas: tokens travel along
 * the connections, the element at work lights up, visited elements stay
 * marked, and where a path fails the spot turns red. Pure overlay — the
 * diagram itself is not changed.
 */

export type SimSpeed = "slow" | "normal" | "fast";
const PX_PER_S: Record<SimSpeed, number> = { slow: 160, normal: 380, fast: 950 };
const PAUSE_MS: Record<SimSpeed, number> = { slow: 420, normal: 200, fast: 70 };
const MARKERS = ["sim-active", "sim-visited", "sim-problem"];

interface Point {
  x: number;
  y: number;
}

export class AutoSimPlayer {
  private run = 0;
  private marked = new Set<string>();

  constructor(private readonly modeler: Modeler) {}

  private get canvas() {
    return this.modeler.get<any>("canvas");
  }
  private get registry() {
    return this.modeler.get<any>("elementRegistry");
  }

  /** Stop any running playback and remove all marks. */
  stop(): void {
    this.run++;
    this.clear();
  }

  clear(): void {
    for (const id of this.marked) for (const m of MARKERS) if (this.registry.get(id)) this.canvas.removeMarker(id, m);
    this.marked.clear();
    const layer = this.layer();
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  /** Play one scenario; resolves false if stopped meanwhile. */
  async play(sc: Scenario, speed: SimSpeed): Promise<boolean> {
    const run = ++this.run;
    this.clear();
    const alive = () => run === this.run;
    for (const round of sc.rounds) {
      if (!alive()) return false;
      const ids = round.flatMap((f) => [f.node, ...f.extra]);
      for (const id of ids) this.mark(id, "sim-active");
      for (const f of round) for (const e of f.consumed) this.mark(e, "sim-visited");
      await sleep(PAUSE_MS[speed]);
      if (!alive()) return false;
      for (const id of ids) {
        this.unmark(id, "sim-active");
        this.mark(id, "sim-visited");
      }
      await Promise.all(round.flatMap((f) => f.produced.map((e) => this.travel(e, speed, alive))));
    }
    if (!alive()) return false;
    for (const id of sc.problemAt) this.mark(id, "sim-problem");
    return true;
  }

  private mark(id: string, marker: string) {
    if (!this.registry.get(id)) return;
    this.canvas.addMarker(id, marker);
    this.marked.add(id);
  }
  private unmark(id: string, marker: string) {
    if (this.registry.get(id)) this.canvas.removeMarker(id, marker);
  }

  private layer(): SVGGElement {
    return this.canvas.getLayer("flowcraft-autosim", 1100);
  }

  /** A token running along one connection. */
  private travel(connectionId: string, speed: SimSpeed, alive: () => boolean): Promise<void> {
    const conn = this.registry.get(connectionId);
    const pts: Point[] | undefined = conn?.waypoints;
    if (!pts || pts.length < 2) return Promise.resolve();
    this.mark(connectionId, "sim-visited");
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = lengths.reduce((a, b) => a + b, 0);
    const duration = Math.max(180, (total / PX_PER_S[speed]) * 1000);
    const ns = "http://www.w3.org/2000/svg";
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("r", "7");
    dot.setAttribute("class", "sim-token");
    this.layer().appendChild(dot);
    const at = (t: number): Point => {
      let d = t * total;
      for (let i = 0; i < lengths.length; i++) {
        if (d <= lengths[i] || i === lengths.length - 1) {
          const r = lengths[i] ? Math.min(1, d / lengths[i]) : 1;
          return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r };
        }
        d -= lengths[i];
      }
      return pts[pts.length - 1];
    };
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const p = at(t);
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        if (t < 1 && alive()) requestAnimationFrame(frame);
        else {
          dot.remove();
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
