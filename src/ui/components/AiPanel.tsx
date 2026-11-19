import { useRef, useState } from "react";
import { DescriptionPanel } from "./DescriptionPanel";
import { useEditor } from "@state/store";
import { ai } from "@core/index";
import { documentToMarkdown } from "../import/document";
import { imagesLeft } from "../import/images";


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
            <span className="muted">oder Dateien ins Textfeld ziehen</span>
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
              {review.findings && review.findings.length > 0 && (
                <div className="review-block findings">
                  <h5>Qualitätshinweise</h5>
                  <ul>{review.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
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
                  <ul>{review.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
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
            <div className="q-text">{q.about && <b>{q.about}: </b>}{q.question}</div>
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
      <div className="tags">{items.map((it, i) => <span key={i} className="tag">{it}</span>)}</div>
    </div>
  );
}
