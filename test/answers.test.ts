import { describe, expect, it } from "vitest";
import { buildAnswerInstruction, mergeAmbiguities } from "../src/core/ai/answers";

const q1 = { about: "Freigabe", question: "Wer gibt frei, wenn die GL abwesend ist?", options: ["Stellvertretung", "Niemand"] };
const q2 = { about: "Frist", question: "Was passiert bei verpasster Frist?" };
const q3 = { about: "Einkauf", question: "Holt der Einkauf immer drei Offerten ein?" };

describe("answering open questions", () => {
  it("builds one instruction with each question and its answer", () => {
    const text = buildAnswerInstruction([{ question: q1, answer: " Die Stellvertretung der GL " }]);
    expect(text).toContain("Rückfrage zu „Freigabe“: Wer gibt frei, wenn die GL abwesend ist?");
    expect(text).toContain("Antwort: Die Stellvertretung der GL");
    expect(text).toMatch(/keine erneute Rückfrage/);
  });

  it("keeps unanswered questions, drops answered ones, adds new ones without duplicates", () => {
    const fresh = [{ ...q2, question: "was passiert bei verpasster frist?" }, q3, { ...q1 }];
    expect(mergeAmbiguities([q1, q2], [q1], fresh)).toEqual([q2, q3]);
  });
});
