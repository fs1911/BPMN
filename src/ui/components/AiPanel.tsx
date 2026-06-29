import { useState } from "react";
import { useEditor } from "@state/store";

const SAMPLE = `Wenn eine Bestellanforderung eingeht, erfasst der Sachbearbeiter sie im System.
Der Einkäufer prüft die Anforderung auf Vollständigkeit.
Wenn die Anforderung unvollständig ist, zurück an den Antragsteller senden.
Der Abteilungsleiter gibt die Anforderung frei.
Das System erstellt eine Bestellung.
Der Prozess endet, wenn die Bestellung an den Lieferanten gesendet wurde.`;

export function AiPanel() {
  const store = useEditor;
  const messages = useEditor((s) => s.aiMessages);
  const review = useEditor((s) => s.aiReview);
  const busy = useEditor((s) => s.aiBusy);
  const [tab, setTab] = useState<"generate" | "review">("generate");
  const [text, setText] = useState(SAMPLE);
  const [instruction, setInstruction] = useState("");

  return (
    <div className="panel ai">
      <div className="tabs">
        <button className={tab === "generate" ? "on" : ""} onClick={() => setTab("generate")}>KI-Modellierung</button>
        <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>Überprüfung</button>
      </div>

      {tab === "generate" && (
        <div className="ai-generate">
          <h4>Prozess beschreiben</h4>
          <textarea value={text} rows={8} onChange={(e) => setText(e.target.value)} placeholder="Arbeitsanweisung, E-Mail, Besprechungsnotizen oder Schrittliste einfügen…" />
          <button disabled={busy} onClick={() => void store.getState().generate(text)}>{busy ? "Generiere…" : "BPMN-Entwurf generieren"}</button>

          <h4>Per Anweisung aktualisieren</h4>
          <div className="row">
            <input
              value={instruction}
              placeholder='z. B. „Eine Freigabe durch den Manager vor dem Versand hinzufügen“'
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim()) {
                  void store.getState().instruct(instruction.trim());
                  setInstruction("");
                }
              }}
            />
            <button disabled={busy} onClick={() => { if (instruction.trim()) { void store.getState().instruct(instruction.trim()); setInstruction(""); } }}>Anwenden</button>
          </div>
          <div className="quick-cmds">
            {["Nachbearbeitungsschleife für unvollständige Dokumente erstellen", "Ausnahmepfad hinzufügen, wenn die Genehmigung fehlt", "Einkauf und Finanzen in separate Bahnen aufteilen"].map((c) => (
              <button key={c} className="chip" disabled={busy} onClick={() => void store.getState().instruct(c)}>{c}</button>
            ))}
          </div>

          <div className="chat">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>{m.text}</div>
            ))}
          </div>
        </div>
      )}

      {tab === "review" && (
        <div className="ai-review">
          {!review && <p className="muted">Generieren Sie ein Diagramm, um die Auswertung zu sehen: erkannte Rollen, Entscheidungen, Schleifen, Ausnahmen, Annahmen und Unklarheiten.</p>}
          {review && (
            <>
              <div className="confidence">
                <span>Konfidenz</span>
                <div className="bar"><div style={{ width: `${review.confidence * 100}%` }} /></div>
                <b>{(review.confidence * 100).toFixed(0)}%</b>
              </div>
              <ReviewList title="Rollen / Bahnen" items={review.roles} />
              <ReviewList title="Systeme" items={review.systems} />
              <ReviewList title="Dokumente / Daten" items={review.dataObjects} />
              <ReviewList title="Entscheidungen" items={review.decisions} />
              <ReviewList title="Freigaben" items={review.approvals} />
              <ReviewList title="Prüfungen / Kontrollen" items={review.checks} />
              <ReviewList title="Nachbearbeitungsschleifen" items={review.loops} />
              <ReviewList title="Ausnahmen" items={review.exceptions} />
              {review.assumptions.length > 0 && (
                <div className="review-block assumptions">
                  <h5>Getroffene Annahmen</h5>
                  <ul>{review.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              {review.ambiguities.length > 0 && (
                <div className="review-block ambiguities">
                  <h5>Offene Fragen / Unklarheiten</h5>
                  <ul>{review.ambiguities.map((a, i) => <li key={i}><b>{a.about}:</b> {a.question}{a.options ? ` (${a.options.join(" / ")})` : ""}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="review-block">
      <h5>{title}</h5>
      <div className="tags">{items.map((it, i) => <span key={i} className="tag">{it}</span>)}</div>
    </div>
  );
}
