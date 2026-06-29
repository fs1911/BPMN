import { useState } from "react";
import { useEditor } from "@state/store";

const SAMPLE = `When a purchase request is received, the requester submits it in the system.
The procurement officer checks the request for completeness.
If the request is incomplete, send it back to the requester.
The department head approves the request.
The system creates a purchase order.
The process ends when the order is sent to the supplier.`;

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
        <button className={tab === "generate" ? "on" : ""} onClick={() => setTab("generate")}>AI Modeling</button>
        <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>Review</button>
      </div>

      {tab === "generate" && (
        <div className="ai-generate">
          <h4>Describe a process</h4>
          <textarea value={text} rows={8} onChange={(e) => setText(e.target.value)} placeholder="Paste an SOP, email, meeting notes or a step list…" />
          <button disabled={busy} onClick={() => store.getState().generate(text)}>Generate BPMN draft</button>

          <h4>Update by instruction</h4>
          <div className="row">
            <input
              value={instruction}
              placeholder='e.g. "Add an approval by the manager before shipment"'
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim()) {
                  store.getState().instruct(instruction.trim());
                  setInstruction("");
                }
              }}
            />
            <button onClick={() => { if (instruction.trim()) { store.getState().instruct(instruction.trim()); setInstruction(""); } }}>Apply</button>
          </div>
          <div className="quick-cmds">
            {["Create a rework loop for incomplete documents", "Add an exception path if the permit is missing", "Split procurement and finance into separate lanes"].map((c) => (
              <button key={c} className="chip" onClick={() => store.getState().instruct(c)}>{c}</button>
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
          {!review && <p className="muted">Generate a diagram to see the extraction review: detected roles, decisions, loops, exceptions, assumptions and ambiguities.</p>}
          {review && (
            <>
              <div className="confidence">
                <span>Confidence</span>
                <div className="bar"><div style={{ width: `${review.confidence * 100}%` }} /></div>
                <b>{(review.confidence * 100).toFixed(0)}%</b>
              </div>
              <ReviewList title="Roles / lanes" items={review.roles} />
              <ReviewList title="Systems" items={review.systems} />
              <ReviewList title="Documents / data" items={review.dataObjects} />
              <ReviewList title="Decisions" items={review.decisions} />
              <ReviewList title="Approvals" items={review.approvals} />
              <ReviewList title="Checks / controls" items={review.checks} />
              <ReviewList title="Rework loops" items={review.loops} />
              <ReviewList title="Exceptions" items={review.exceptions} />
              {review.assumptions.length > 0 && (
                <div className="review-block assumptions">
                  <h5>Assumptions made</h5>
                  <ul>{review.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              {review.ambiguities.length > 0 && (
                <div className="review-block ambiguities">
                  <h5>Open questions / ambiguities</h5>
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
