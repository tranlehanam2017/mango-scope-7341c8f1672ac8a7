import { describe, expect, it } from "vitest";
import { RecordStore } from "../src/core/store";
import type { LifeRecord } from "../src/types";

const rec = (overrides: Partial<LifeRecord> = {}): LifeRecord => ({
  id: "a", title: "A", category: "X", dueDate: "2026-08-20", effort: 30,
  impact: 3, status: "planned", notes: "", createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z", ...overrides,
});

describe("RecordStore", () => {
  it("upserts and lists records", () => {
    const store = new RecordStore("store-test-1", []);
    store.upsert(rec());
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.id).toBe("a");
  });

  it("removes a record and clears dangling references", () => {
    const store = new RecordStore("store-test-2", [
      rec({ id: "a" }),
      rec({ id: "b", dependsOn: "a", parentId: "a" }),
    ]);
    store.remove("a");
    expect(store.all()).toHaveLength(1);
    const remaining = store.all()[0]!;
    expect(remaining.dependsOn).toBeUndefined();
    expect(remaining.parentId).toBeUndefined();
  });

  it("restores state via undo", () => {
    const store = new RecordStore("store-test-3", [rec()]);
    store.remove("a");
    expect(store.all()).toHaveLength(0);
    store.undo();
    expect(store.all()).toHaveLength(1);
  });

  it("normalizes dangling and self references on replace", () => {
    const store = new RecordStore("store-test-4", []);
    store.replace([
      rec({ id: "a", dependsOn: "missing" }),
      rec({ id: "b", parentId: "b" }),
    ]);
    const a = store.all().find((item) => item.id === "a")!;
    const b = store.all().find((item) => item.id === "b")!;
    expect(a.dependsOn).toBeUndefined();
    expect(b.parentId).toBeUndefined();
  });

  it("breaks cyclic relationships on replace", () => {
    const store = new RecordStore("store-test-5", []);
    store.replace([
      rec({ id: "x", dependsOn: "y" }),
      rec({ id: "y", dependsOn: "x" }),
    ]);
    const x = store.all().find((item) => item.id === "x")!;
    const y = store.all().find((item) => item.id === "y")!;
    expect(x.dependsOn === undefined || y.dependsOn === undefined).toBe(true);
  });

  it("rejects duplicate ids on replace", () => {
    const store = new RecordStore("store-test-6", [rec()]);
    store.replace([rec(), rec()]);
    expect(store.all()).toHaveLength(1);
  });
});
