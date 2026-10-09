// Builds a Claude Messages API event stream (SSE) the way the server passes it
// through, for tests and browser smoke tests. Answers the generate endpoint
// with `graph` as the model's JSON output.
//
// options: { stopReason = "end_turn", fallback = false, error, cutAfter, chunk = 40 }
//   fallback: a mid-answer decline + `fallback` block + continued text
//   error:    an `error` event (e.g. "overloaded_error") instead of the end
//   cutAfter: stop the stream after this many events (connection lost)
export function claudeSse(graph, options = {}) {
  const { stopReason = "end_turn", fallback = false, error, cutAfter, chunk = 40 } = options;
  const json = JSON.stringify(graph);
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [
    ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
    ev("content_block_stop", { index: 0 }),
    "event: ping\ndata: {\"type\": \"ping\"}\n\n",
  ];
  let idx = 1;
  const text = (s) => {
    out.push(ev("content_block_start", { index: idx, content_block: { type: "text", text: "" } }));
    for (let i = 0; i < s.length; i += chunk) out.push(ev("content_block_delta", { index: idx, delta: { type: "text_delta", text: s.slice(i, i + chunk) } }));
    out.push(ev("content_block_stop", { index: idx }));
    idx++;
  };
  if (fallback) {
    const cut = Math.floor(json.length / 3);
    text(json.slice(0, cut));
    out.push(ev("content_block_start", { index: idx, content_block: { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } } }));
    out.push(ev("content_block_stop", { index: idx }));
    idx++;
    text(json.slice(cut));
  } else {
    text(json);
  }
  if (error) out.push(ev("error", { error: { type: error, message: "Overloaded" } }));
  else {
    out.push(ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 100 } }));
    out.push(ev("message_stop", {}));
  }
  return (cutAfter ? out.slice(0, cutAfter) : out).join("");
}

export const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8" };
