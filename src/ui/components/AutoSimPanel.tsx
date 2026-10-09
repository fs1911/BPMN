import { useEffect, useRef, useState } from "react";
import { useEditor } from "@state/store";
import { enumerateScenarios, type Scenario } from "@core/index";
import { getModelFromModeler } from "@ui/bpmn/bridge";
import { AutoSimPlayer, type SimSpeed } from "@ui/bpmn/auto-sim";

const ICON: Record<Scenario["outcome"], string> = { ok: "✓", loop: "⟳", deadlock: "✕", unsafe: "✕", "too-long": "…" };

/**
 * Automatic simulation: plays every way through the process by itself — at
 * each gateway every answer is taken in some path — and judges each path.
 * Shows the result of the exhaustive check (all combinations) alongside.
 */
export function AutoSimPanel() {
  const open = useEditor((s) => s.autoSimOpen);
  const issues = useEditor((s) => s.issues);
  const [paths, setPaths] = useState<Scenario[]>();
  const [truncated, setTruncated] = useState(false);
  const [current, setCurrent] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>("normal");
  const [done, setDone] = useState<Set<number>>(new Set());
  const player = useRef<AutoSimPlayer>();
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const flowErrors = issues.filter((i) => i.rule.startsWith("simulation.") && i.severity === "error");

  const stop = () => {
    player.current?.stop();
    setPlaying(false);
  };

  // (Re)compute the paths when opened; stop and clear when closed or when the diagram changes.
  useEffect(() => {
    const m = useEditor.getState().modeler;
    if (!open || !m) return;
    player.current = new AutoSimPlayer(m);
    // The manual token simulation and this overlay should not run at the same time.
    try {
      m.get<any>("toggleMode").toggleMode(false);
    } catch {
      /* not loaded */
    }
    let cancelled = false;
    const compute = async () => {
      const model = await getModelFromModeler(m);
      if (cancelled) return;
      const r = enumerateScenarios(model);
      setPaths(r.scenarios);
      setTruncated(r.truncated);
      setDone(new Set());
      setCurrent(undefined);
    };
    void compute();
    const onChange = () => {
      stop();
      void compute();
    };
    m.on("commandStack.changed", onChange);
    m.on("import.done", onChange);
    return () => {
      cancelled = true;
      m.off("commandStack.changed", onChange);
      m.off("import.done", onChange);
      player.current?.stop();
      setPlaying(false);
    };
  }, [open]);

  if (!open) return null;

  const playFrom = async (indices: number[]) => {
    if (!paths || !player.current) return;
    setPlaying(true);
    for (const i of indices) {
      setCurrent(i);
      const finished = await player.current.play(paths[i], speedRef.current);
      if (!finished) return;
      setDone((d) => new Set(d).add(i));
      if (indices.length > 1 && i !== indices[indices.length - 1]) await new Promise((r) => setTimeout(r, 900));
    }
    setPlaying(false);
  };
  const bad = paths?.filter((p) => p.outcome === "deadlock" || p.outcome === "unsafe").length ?? 0;
  const close = () => {
    stop();
    useEditor.getState().setAutoSimOpen(false);
  };

  return (
    <div className="autosim" role="region" aria-label="Automatische Simulation">
      <div className="autosim-head">
        <strong>Automatische Simulation</strong>
        <button className="lib-close" onClick={close} title="Schliessen">✕</button>
      </div>
      <div className={`autosim-verdict ${flowErrors.length ? "bad" : "good"}`}>
        {flowErrors.length
          ? `✕ Vollständige Prüfung aller Kombinationen: ${flowErrors.length} Ablauffehler – Details in der Diagramm-Prüfung.`
          : "✓ Vollständige Prüfung aller Kombinationen: keine Ablauffehler."}
      </div>
      <div className="autosim-controls">
        {!playing ? (
          <button className="autosim-play" disabled={!paths?.length} onClick={() => void playFrom(paths!.map((_, i) => i))}>
            ▶ Alle {paths?.length ?? ""} Wege abspielen
          </button>
        ) : (
          <button className="autosim-play" onClick={stop}>■ Stopp</button>
        )}
        <select value={speed} onChange={(e) => setSpeed(e.target.value as SimSpeed)} aria-label="Geschwindigkeit">
          <option value="slow">Langsam</option>
          <option value="normal">Normal</option>
          <option value="fast">Schnell</option>
        </select>
        {!playing && current !== undefined && (
          <button onClick={() => (player.current?.clear(), setCurrent(undefined))} title="Markierungen entfernen">Zurücksetzen</button>
        )}
      </div>
      {paths && (
        <p className="muted autosim-summary">
          {paths.length} Wege decken jede Antwort an jedem Gateway ab{truncated ? " (Auswahl – es gibt noch mehr)" : ""}.
          {done.size > 0 && ` Abgespielt: ${done.size} · ${bad ? `${bad} mit Problem` : "alle ohne Problem"}.`}
        </p>
      )}
      <ol className="autosim-paths">
        {paths?.map((p, i) => (
          <li
            key={i}
            className={`${p.outcome}${current === i ? " current" : ""}${done.has(i) ? " done" : ""}`}
            onClick={() => {
              if (playing) stop();
              void playFrom([i]);
            }}
            title="Diesen Weg abspielen"
          >
            <span className="autosim-icon">{ICON[p.outcome]}</span>
            <div>
              <div className="autosim-name">
                Weg {i + 1}
                {current === i && playing && <em> · läuft …</em>}
              </div>
              {p.choices.length > 0 && <div className="autosim-choices">{p.choices.map((c) => c.label).join(" → ")}</div>}
              <div className="autosim-result">{p.verdict}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
