import type { Ambiguity } from "./types";

/**
 * Answering the AI's open questions. The answers go to the AI edit as one
 * instruction; questions without an answer stay open, and questions the edit
 * raises are added to them.
 */

export interface AnsweredQuestion {
  question: Ambiguity;
  answer: string;
}

export function buildAnswerInstruction(answers: AnsweredQuestion[]): string {
  const lines = answers.map(
    ({ question: q, answer }, i) => `${i + 1}. Rückfrage${q.about ? ` zu „${q.about}“` : ""}: ${q.question}\n   Antwort: ${answer.trim()}`,
  );
  return [
    "Der Prozessverantwortliche beantwortet offene Rückfragen zum Modell. Passe das Modell entsprechend den Antworten an.",
    "Bestätigt eine Antwort den aktuellen Stand, ändere dafür nichts. Stelle zu diesen Punkten keine erneute Rückfrage.",
    "",
    ...lines,
  ].join("\n");
}

const key = (a: Ambiguity) => a.question.trim().toLowerCase();

/** Open questions after an edit: earlier ones not answered, then new ones (no duplicates). */
export function mergeAmbiguities(previous: Ambiguity[], answered: Ambiguity[], fresh: Ambiguity[]): Ambiguity[] {
  const done = new Set(answered.map(key));
  const out: Ambiguity[] = [];
  const seen = new Set<string>();
  for (const a of [...previous, ...fresh]) {
    if (done.has(key(a)) || seen.has(key(a))) continue;
    seen.add(key(a));
    out.push(a);
  }
  return out;
}
