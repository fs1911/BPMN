import { BpmnModel, cloneModel } from "../model";

/**
 * Snapshot-based undo/redo history. Each committed change pushes a deep clone
 * of the model. Snapshot history (rather than inverse-command tracking) is
 * chosen deliberately: it is robust against the wide variety of mutations the
 * AI layer and manual editing perform, and keeps undo/redo correctness simple
 * to reason about and test. Coalescing avoids flooding the stack during drags.
 */
export interface HistoryEntry {
  label: string;
  model: BpmnModel;
  ts: number;
}

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private limit: number;

  constructor(initial: BpmnModel, limit = 100) {
    this.past.push({ label: "init", model: cloneModel(initial), ts: Date.now() });
    this.limit = limit;
  }

  get current(): BpmnModel {
    return this.past[this.past.length - 1].model;
  }

  canUndo(): boolean {
    return this.past.length > 1;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Commit a new model state. `coalesceKey` merges consecutive same-key edits. */
  commit(model: BpmnModel, label: string, coalesceKey?: string): void {
    const top = this.past[this.past.length - 1];
    if (coalesceKey && top.label === `~${coalesceKey}`) {
      top.model = cloneModel(model);
      top.ts = Date.now();
    } else {
      this.past.push({
        label: coalesceKey ? `~${coalesceKey}` : label,
        model: cloneModel(model),
        ts: Date.now(),
      });
    }
    this.future = [];
    if (this.past.length > this.limit) this.past.shift();
  }

  undo(): BpmnModel | null {
    if (!this.canUndo()) return null;
    const entry = this.past.pop()!;
    this.future.push(entry);
    return cloneModel(this.current);
  }

  redo(): BpmnModel | null {
    if (!this.canRedo()) return null;
    const entry = this.future.pop()!;
    this.past.push(entry);
    return cloneModel(entry.model);
  }

  labels(): string[] {
    return this.past.map((e) => e.label.replace(/^~/, ""));
  }
}
