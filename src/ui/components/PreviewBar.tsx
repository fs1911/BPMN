import { useEditor } from "@state/store";

/**
 * Human-in-the-loop bar for AI suggestions: an AI change is shown live on the
 * canvas as a preview and the user explicitly accepts or rejects it (rejecting
 * restores the previous diagram). AI output is a draft, never a fait accompli.
 */
export function PreviewBar() {
  const pending = useEditor((s) => s.pending);
  const store = useEditor;
  if (!pending) return null;
  return (
    <div className="preview-bar">
      <span className="pb-tag">KI-Vorschau</span>
      <span className="pb-desc">{pending.description}</span>
      <div className="pb-actions">
        <button className="pb-accept" onClick={() => store.getState().acceptPreview()}>✓ Übernehmen</button>
        <button className="pb-reject" onClick={() => void store.getState().rejectPreview()}>↩ Verwerfen</button>
      </div>
    </div>
  );
}
