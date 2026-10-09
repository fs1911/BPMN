/**
 * Reads Claude's server-sent event stream as passed through by the server
 * (server/llm.ts) and returns the generated JSON text.
 *
 * Events used: content_block_delta (text_delta → output, any delta → alive),
 * message_delta (stop_reason), message_stop, error. Thinking arrives as
 * thinking blocks whose text is empty; their deltas only mean "still working".
 * When a safeguard declines mid-answer and the fallback model takes over, the
 * stream keeps the partial text, inserts a `fallback` block and continues the
 * text, so all text deltas together form the answer.
 */

export interface StreamProgress {
  phase: "thinking" | "writing";
  chars?: number;
}

export interface StreamResult {
  text: string;
  stopReason?: string;
}

export async function readClaudeStream(body: ReadableStream<Uint8Array>, onProgress?: (p: StreamProgress) => void): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let stopReason: string | undefined;
  let complete = false;
  let writing = false;
  let lastReport = 0;
  onProgress?.({ phase: "thinking" });

  const handle = (event: string, data: string) => {
    if (!data) return;
    const ev = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: string; stop_reason?: string };
      error?: { type?: string; message?: string };
    };
    const type = ev.type ?? event;
    if (type === "content_block_delta" && ev.delta?.type === "text_delta") {
      text += ev.delta.text ?? "";
      if (!writing || text.length - lastReport >= 500) {
        writing = true;
        lastReport = text.length;
        onProgress?.({ phase: "writing", chars: text.length });
      }
    } else if (type === "message_delta" && ev.delta?.stop_reason) {
      stopReason = ev.delta.stop_reason;
    } else if (type === "message_stop") {
      complete = true;
    } else if (type === "error") {
      const kind = ev.error?.type ?? "";
      if (kind === "overloaded_error" || kind === "rate_limit_error") throw new Error("KI-Dienst ist ausgelastet – bitte gleich noch einmal versuchen.");
      throw new Error(`KI-Dienst meldet Fehler: ${ev.error?.message ?? kind}`);
    }
  };

  const drain = () => {
    let sep: RegExpExecArray | null;
    while ((sep = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, sep.index);
      buf = buf.slice(sep.index + sep[0].length);
      let event = "";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      handle(event, data.join("\n"));
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    drain();
    if (done) break;
  }
  buf += decoder.decode() + "\n\n";
  drain();

  if (stopReason === "refusal") throw new Error("Die KI hat die Anfrage abgelehnt.");
  if (stopReason === "max_tokens") throw new Error("Die KI-Antwort wurde abgeschnitten (Prozess zu groß).");
  if (!complete && !stopReason) throw new Error("KI-Antwort unvollständig (Verbindung abgebrochen).");
  return { text, stopReason };
}
