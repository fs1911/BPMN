import { useEffect, useRef, useState } from "react";
import { DescriptionPanel } from "./DescriptionPanel";
import { useEditor } from "@state/store";
import { ai } from "@core/index";
import { documentToMarkdown } from "../import/document";
import { imagesLeft } from "../import/images";
import { appendDictated, dictationSupported, startDictation, type Dictation } from "../import/dictation";
import { elementsForText, elementsNamed, showElements } from "../bpmn/locate";

/** Click on a point of the review: show what and where it means in the diagram. */
function locate(text: string, ids: string[] = [], exact = false) {
  const m = useEditor.getState().modeler;
  if (!m) return;
  const found = ids.length ? ids : exact ? [...elementsNamed(m, text), ...elementsForText(m, text)] : elementsForText(m, text);
  if (!showElements(m, found)) useEditor.getState().showToast("Dazu gibt es im Diagramm keine passende Stelle.");
}


export function AiPanel() {
  const store = useEditor;
  const messages = useEditor((s) => s.aiMessages);
  const review = useEditor((s) => s.aiReview);
  const busy = useEditor((s) => s.aiBusy);
  const progress = useEditor((s) => s.aiProgress);
  const selfCorrect = useEditor((s) => s.selfCorrect);
  const offlineOffer = useEditor((s) => s.offlineOffer);
  const [tab, setTab] = useState<"generate" | "review" | "describe">("generate");
  // Kept in the store: it is saved with the process in the library.
  const text = useEditor((s) => s.inputText);
  const setText = useEditor((s) => s.setInputText);
  const [instruction, setInstruction] = useState("");
  const [importing, setImporting] = useState<string>();
  const [importNote, setImportNote] = useState<{ text: string; error?: boolean }>();
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dictation = useRef<Dictation>();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const toggleDictation = () => {
    if (dictation.current) {
      dictation.current.stop();
      return;
    }
    setImportNote(undefined);
    dictation.current = startDictation({
      onText: (t) => setText(appendDictated(store.getState().inputText, t)),
      onInterim: setInterim,
      onEnd: (error) => {
        dictation.current = undefined;
        setListening(false);
        if (error) setImportNote({ text: error, error: true });
      },
    });
    setListening(!!dictation.current);
  };
  useEffect(() => () => dictation.current?.stop(), []);
  const tooLong = text.length > ai.MAX_TEXT_CHARS;
  const images = useEditor((s) => s.inputImages);

  // Word/PDF → Markdown in the browser, photos and picture pages → shrunk images;
  // both land below for review before anything is sent to the AI.
  const importFiles = async (list: FileList | File[] | null | undefined) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setImportNote(undefined);
    const notes: string[] = [];
    const texts: string[] = [];
    let added = [...store.getState().inputImages];
    let error = false;
    for (const file of files) {
      setImporting(file.name);
      try {
        const { markdown, warnings, images: found } = await documentToMarkdown(file, imagesLeft(added.length));
        if (markdown.trim()) {
          texts.push(markdown);
          notes.push(`„${file.name}“ übernommen (${markdown.length.toLocaleString("de-CH")} Zeichen).`);
        } else if (found.length) notes.push(`„${file.name}“ als Bild angehängt.`);
        added = [...added, ...found];
        notes.push(...warnings);
      } catch (err) {
        error = true;
        notes.push((err as Error).message || `„${file.name}“ konnte nicht gelesen werden.`);
      }
    }
    setImporting(undefined);
    if (texts.length) setText(texts.join("\n\n"));
    store.getState().setInputImages(added);
    if (texts.length) notes.push("Bitte prüfen und Abschnitte ohne Ablauf löschen, dann generieren.");
    else if (!error && added.length) notes.push("Ein Text ist nicht nötig – ergänzende Hinweise im Textfeld helfen der KI aber.");
    setImportNote({ text: notes.join(" "), error: error && !texts.length && !added.length });
  };
  const removeImage = (i: number) => store.getState().setInputImages(images.filter((_, k) => k !== i));

  return (
    <div className="panel ai">
      <div className="tabs">
        <button className={tab === "generate" ? "on" : ""} onClick={() => setTab("generate")}>KI-Modellierung</button>
        <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>Überprüfung</button>
        <button className={tab === "describe" ? "on" : ""} onClick={() => setTab("describe")}>Beschreibung</button>
      </div>

      {tab === "generate" && (
        <div className="ai-generate">
          <h4>Prozess beschreiben</h4>
          <div className="doc-import">
            <button disabled={busy || !!importing} onClick={() => fileInput.current?.click()}>
              {importing ? `Lese ${importing}…` : "Word / PDF / Foto laden"}
            </button>
            <button
              className={`dictate${listening ? " on" : ""}`}
              disabled={busy || !dictationSupported()}
              aria-pressed={listening}
              onClick={toggleDictation}
              title={
                dictationSupported()
                  ? "Prozess frei erzählen – der Text erscheint im Feld und lässt sich vor dem Generieren korrigieren. „neuer Absatz“ / „neue Zeile“ trennen Abschnitte. Hinweis: Chrome und Edge schicken die Aufnahme zur Erkennung an Google bzw. Microsoft."
                  : "Spracheingabe wird von diesem Browser nicht unterstützt (Chrome, Edge oder Safari verwenden)."
              }
            >
              {listening ? "■ Diktat beenden" : "🎤 Diktieren"}
            </button>
            {!listening && <span className="muted">oder hineinziehen</span>}
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,.heic,.heif"
              onChange={(e) => {
                void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            className={dragOver ? "drop" : undefined}
            value={text}
            rows={8}
            onChange={(e) => setText(e.target.value)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragOver(true);
              }
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              setDragOver(false);
              void importFiles(e.dataTransfer.files);
            }}
            placeholder="Arbeitsanweisung, E-Mail, Besprechungsnotizen oder Schrittliste einfügen – oder Word, PDF oder Fotos (Whiteboard, Notizen, Skizze) laden…"
          />
          {listening && (
            <p className="dictation-live" aria-live="polite">
              <span className="rec-dot" /> Hört zu… {interim && <em>{interim}</em>}
            </p>
          )}
          {importNote && <p className={`import-note${importNote.error ? " error" : ""}`}>{importNote.text}</p>}
          <p className={`char-count${tooLong ? " error" : ""}`}>
            {text.length.toLocaleString("de-CH")} / {ai.MAX_TEXT_CHARS.toLocaleString("de-CH")} Zeichen{tooLong ? " – zu lang, bitte kürzen" : ""}
          </p>
          {images.length > 0 && (
            <div className="img-attachments" aria-label="Angehängte Bilder">
              <div className="img-head">
                <span>
                  📎 {images.length} / {ai.MAX_IMAGES} Bild(er) für die KI
                </span>
                <button className="link" disabled={busy} onClick={() => store.getState().setInputImages([])}>
                  alle entfernen
                </button>
              </div>
              <ul>
                {images.map((img, i) => (
                  <li key={`${img.name}-${i}`} title={`${img.name} · ${img.width}×${img.height} px · ${Math.round((img.data.length * 3) / 4 / 1024)} KB`}>
                    <img src={img.thumb} alt={img.name} />
                    <span className="img-name">{img.name}</span>
                    <button className="img-remove" disabled={busy} onClick={() => removeImage(i)} aria-label={`${img.name} entfernen`}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button disabled={busy || tooLong || (!text.trim() && !images.length)} onClick={() => void store.getState().generate(text)}>{busy ? "Generiere…" : "BPMN-Entwurf generieren"}</button>
          <label className="self-correct" title="Findet die Prüfung nach dem Generieren Verstösse gegen die BPMN-Norm, bekommt die KI sie einmal zur Korrektur zurück. Kostet dann eine zweite KI-Anfrage (Zeit und Geld).">
            <input type="checkbox" checked={selfCorrect} onChange={(e) => store.getState().setSelfCorrect(e.target.checked)} />
            <span>Normverstösse automatisch korrigieren lassen (kostet dann eine zweite KI-Anfrage)</span>
          </label>
          {offlineOffer && !busy && (
            <button className="offline-offer" onClick={() => void store.getState().generate(offlineOffer, { offline: true })} title="Regelbasierter Parser ohne KI: versteht nur einfache, nummerierte Schrittlisten – keine Zeichnungen, Bilder oder Fliesstext">
              Ohne KI versuchen (Regel-Parser, nur einfache Schrittlisten)
            </button>
          )}
          {progress && <p className="muted progress">{progress}</p>}
          <ScopeChoiceBox busy={busy} />

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

      {tab === "describe" && <DescriptionPanel />}

      {tab === "review" && (
        <div className="ai-review">
          {!review && <p className="muted">Generieren Sie ein Diagramm, um die Auswertung zu sehen: erkannte Rollen, Entscheidungen, Schleifen, Ausnahmen, Annahmen und Unklarheiten.</p>}
          {review && (
            <>
              <p className="muted source">
                Quelle: {review.source === "llm" ? "KI-Modell (Claude)" : "Regelbasierter Offline-Parser"}
              </p>
              <div className="confidence">
                <span>Konfidenz</span>
                <div className="bar"><div style={{ width: `${review.confidence * 100}%` }} /></div>
                <b>{(review.confidence * 100).toFixed(0)}%</b>
              </div>
              {review.ambiguities.length > 0 && <OpenQuestions questions={review.ambiguities} busy={busy} progress={progress} />}
              {review.improvements && review.improvements.length > 0 && <Improvements items={review.improvements} busy={busy} />}
              {review.findings && review.findings.length > 0 && (
                <div className="review-block findings">
                  <h5>Qualitätshinweise</h5>
                  <ul>
                    {review.findings.map((f, i) => (
                      <li key={i} className="locatable" onClick={() => locate(f)} title="Im Diagramm zeigen">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
                  <ul>
                    {review.assumptions.map((a, i) => (
                      <li key={i} className="locatable" onClick={() => locate(a)} title="Im Diagramm zeigen">
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The scope check found several separate processes in the text: generate one
 * of them (the others stay listed for later) or all in one diagram.
 */
function ScopeChoiceBox({ busy }: { busy: boolean }) {
  const choice = useEditor((s) => s.scopeChoice);
  if (!choice) return null;
  const gen = useEditor.getState().generate;
  return (
    <div className="scope-choice">
      <h5>Mehrere Prozesse im Text erkannt ({choice.processes.length})</h5>
      <p className="hint">
        Jeder hat einen eigenen Auslöser und ein eigenes Ergebnis. Empfehlung: je Prozess ein eigenes Diagramm – kleiner, ohne Kreuzungen zwischen fremden Abläufen, einzeln
        freigebbar. Übergaben zwischen den Prozessen erscheinen als Nachrichten-Ereignisse.
      </p>
      {choice.relation && <p className="hint muted">{choice.relation}</p>}
      <ol>
        {choice.processes.map((p) => {
          const done = choice.done.includes(p.title);
          return (
            <li key={p.title}>
              <div className="scope-title">
                <b>{p.title}</b> {done && <span className="done">✓ erzeugt</span>}
              </div>
              <div className="muted">Auslöser: {p.trigger}</div>
              {p.summary && <div className="muted">{p.summary}</div>}
              <button disabled={busy} onClick={() => void gen(choice.text, { focus: p })}>
                {done ? "Nochmals erzeugen" : "Diesen Prozess erzeugen"}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <button className="secondary" disabled={busy} onClick={() => void gen(choice.text, { whole: true })} title="Alles in ein Diagramm – grösser, eher Kreuzungen">
          Trotzdem alles in ein Diagramm
        </button>
        <button className="secondary" disabled={busy} onClick={() => useEditor.getState().dismissScopeChoice()}>
          Schliessen
        </button>
      </div>
    </div>
  );
}

const IMPROVEMENT_LABEL: Record<ai.Improvement["kind"], string> = {
  optimierung: "Optimierung",
  automatisierung: "Automatisierung",
  "best-practice": "Best Practice",
};

/**
 * The AI's suggestions to improve or automate the process. None is built into
 * the diagram; each is applied (as an AI edit with preview) or dismissed by the owner.
 */
function Improvements({ items, busy }: { items: ai.Improvement[]; busy: boolean }) {
  const open = items.filter((x) => !x.status).length;
  return (
    <div className="review-block improvements">
      <h5>Verbesserungsvorschläge ({open} offen)</h5>
      <p className="hint">Nicht eingebaut – das Diagramm zeigt den Prozess wie beschrieben. „Umsetzen“ ändert das Diagramm als Vorschau.</p>
      <ul>
        {items.map((x, i) => (
          <li key={i} className={`improvement ${x.kind} ${x.status ?? ""}`}>
            <div className="locatable" onClick={() => locate(`${x.title} ${x.description}`, x.elementIds)} title="Im Diagramm zeigen">
              <span className={`kind ${x.kind}`}>{IMPROVEMENT_LABEL[x.kind]}</span> <b>{x.title}</b>
              <div>{x.description}</div>
            </div>
            {x.status ? (
              <div className="muted status">{x.status === "applied" ? "✓ umgesetzt (Vorschau)" : "verworfen"}</div>
            ) : (
              <div className="row">
                <button disabled={busy} onClick={() => void useEditor.getState().applyImprovement(i)}>Umsetzen</button>
                <button className="secondary" disabled={busy} onClick={() => useEditor.getState().dismissImprovement(i)}>Verwerfen</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The AI's open questions with an answer field each. All answers go to the AI
 * in one edit; unanswered questions stay open.
 */
function OpenQuestions({ questions, busy, progress }: { questions: ai.Ambiguity[]; busy: boolean; progress?: string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const given = questions.filter((q) => answers[q.question]?.trim());
  const set = (q: ai.Ambiguity, v: string) => setAnswers((a) => ({ ...a, [q.question]: v }));
  const submit = async () => {
    const batch = given.map((q) => ({ question: q, answer: answers[q.question] }));
    await useEditor.getState().answerQuestions(batch);
    // Answered questions leave the list; keep what was typed for the others.
    setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !batch.some((b) => b.question.question === k))));
  };
  return (
    <div className="review-block ambiguities">
      <h5>Offene Fragen ({questions.length})</h5>
      <p className="muted hint">Beantworte, was du weisst – die KI arbeitet die Antworten ins Diagramm ein. Unbeantwortete Fragen bleiben offen.</p>
      <ol className="questions">
        {questions.map((q) => (
          <li key={q.question}>
            <div className="q-text locatable" onClick={() => locate(`${q.about} ${q.question}`, q.elementIds)} title="Im Diagramm zeigen, worum es geht">
              {q.about && <b>{q.about}: </b>}
              {q.question} <span className="locate-pin" aria-hidden>📍</span>
            </div>
            {q.options && q.options.length > 0 && (
              <div className="q-options">
                {q.options.map((o) => (
                  <button key={o} className={`chip${answers[q.question] === o ? " on" : ""}`} disabled={busy} onClick={() => set(q, o)}>{o}</button>
                ))}
              </div>
            )}
            <textarea
              rows={2}
              value={answers[q.question] ?? ""}
              disabled={busy}
              placeholder="Antwort…"
              onChange={(e) => set(q, e.target.value)}
            />
          </li>
        ))}
      </ol>
      <button className="submit-answers" disabled={busy || !given.length} onClick={() => void submit()}>
        {busy ? "KI arbeitet…" : given.length ? `${given.length} Antwort(en) an KI übergeben` : "Antworten an KI übergeben"}
      </button>
      {busy && progress && <p className="muted progress">{progress}</p>}
    </div>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="review-block">
      <h5>{title}</h5>
      <div className="tags">
        {items.map((it, i) => (
          <button key={i} className="tag locatable" onClick={() => locate(it, [], true)} title="Im Diagramm zeigen">
            {it}
          </button>
        ))}
      </div>
    </div>
  );
}
