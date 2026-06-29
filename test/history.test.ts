import { describe, expect, it } from "vitest";
import { History } from "../src/core/commands";
import { createNode } from "../src/core/model";
import { buildSampleProcess } from "./helpers";

describe("undo/redo history", () => {
  it("undoes and redoes a change", () => {
    const m = buildSampleProcess();
    const h = new History(m);
    expect(h.canUndo()).toBe(false);

    const m2 = buildSampleProcess();
    createNode(m2, "task", { id: "extra", name: "Extra step" });
    h.commit(m2, "add task");
    expect(h.canUndo()).toBe(true);
    expect(Object.keys(h.current.nodes)).toContain("extra");

    const undone = h.undo();
    expect(undone && Object.keys(undone.nodes)).not.toContain("extra");
    expect(h.canRedo()).toBe(true);

    const redone = h.redo();
    expect(redone && Object.keys(redone.nodes)).toContain("extra");
  });

  it("coalesces consecutive edits with the same key", () => {
    const m = buildSampleProcess();
    const h = new History(m);
    const a = buildSampleProcess();
    a.nodes["check"].bounds.x = 10;
    h.commit(a, "drag", "drag-check");
    const b = buildSampleProcess();
    b.nodes["check"].bounds.x = 20;
    h.commit(b, "drag", "drag-check");
    // only one undo step should exist for the coalesced drag
    h.undo();
    expect(h.canUndo()).toBe(false);
  });

  it("clears the redo stack after a new commit", () => {
    const m = buildSampleProcess();
    const h = new History(m);
    h.commit(buildSampleProcess(), "one");
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.commit(buildSampleProcess(), "two");
    expect(h.canRedo()).toBe(false);
  });

  it("snapshots are isolated (mutating after commit does not change history)", () => {
    const m = buildSampleProcess();
    const h = new History(m);
    m.nodes["check"].name = "MUTATED";
    expect(h.current.nodes["check"].name).not.toBe("MUTATED");
  });
});
