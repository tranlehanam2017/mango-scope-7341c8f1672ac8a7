import { describe, expect, it } from "vitest";
import { importJson } from "../src/core/exchange";
import { buildPlan, daysBetween, priorityFor, suggestDailyLoad, summarize } from "../src/core/planner";
import { theme } from "../src/theme";
import type { LifeRecord } from "../src/types";

const item = (overrides: Partial<LifeRecord> = {}): LifeRecord => ({
  id: "one", title: "Example", category: "General", dueDate: "2026-08-20", effort: 30,
  impact: 3, status: "planned", notes: "", createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z", ...overrides,
});

describe("planning engine", () => {
  it("calculates calendar-day distance without local time drift", () => expect(daysBetween("2026-08-19", "2026-08-20")).toBe(1));
  it("ranks overdue high-impact work above distant work", () => {
    const overdue = item({ id: "late", dueDate: "2026-08-18", impact: 5 });
    const distant = item({ id: "later", dueDate: "2026-09-20", impact: 2 });
    expect(buildPlan([distant, overdue], "2026-08-20")[0]!.item.id).toBe("late");
  });
  it("removes completed work from the active plan", () => expect(buildPlan([item({ status: "done" })], "2026-08-19")).toHaveLength(0));
  it("explains the score", () => expect(priorityFor(item(), "2026-08-19").reasons.join(" ")).toContain("due in 1 day"));
  it("summarizes status and workload", () => {
    const result = summarize([item(), item({ id: "two", status: "done", category: "Other" })], "2026-08-19");
    expect(result).toMatchObject({ total: 2, completed: 1, dueSoon: 1, effort: 30 });
  });
  it("flags a day whose assigned effort exceeds capacity", () => {
    const week = suggestDailyLoad([item({ effort: 120 })], 60, "2026-08-19");
    expect(week.some((day) => day.overloaded)).toBe(true);
  });

  describe("scoring nuances", () => {
    it("applies a decay penalty for very distant items", () => {
      const near = item({ id: "near", dueDate: "2026-08-25", impact: 3 }); // 5 days away
      const far = item({ id: "far", dueDate: "2026-12-25", impact: 3 });   // months away
      const today = "2026-08-20";
      
      const scoreNear = priorityFor(near, today).score;
      const scoreFar = priorityFor(far, today).score;
      
      expect(scoreNear).toBeGreaterThan(scoreFar);
    });

    it("boosts active items", () => {
      const planned = item({ id: "p", status: "planned" });
      const active = item({ id: "a", status: "active" });
      const today = "2026-08-20";
      
      expect(priorityFor(active, today).score).toBeGreaterThan(priorityFor(planned, today).score);
    });

    it("applies critical boost for impact 5", () => {
      const highImpact = item({ id: "high", impact: 5 });
      const midImpact = item({ id: "mid", impact: 4 });
      const today = "2026-08-20";
      
      // The gap should be more than just the base impact difference (5*20 vs 4*20)
      const diff = priorityFor(highImpact, today).score - priorityFor(midImpact, today).score;
      expect(diff).toBeGreaterThan(20);
    });

    it("penalizes inactive overdue items", () => {
      const plannedOverdue = item({ id: "p", status: "planned", dueDate: "2026-08-10" });
      const activeOverdue = item({ id: "a", status: "active", dueDate: "2026-08-10" });
      const today = "2026-08-20";
      
      const scorePlanned = priorityFor(plannedOverdue, today).score;
      const scoreActive = priorityFor(activeOverdue, today).score;
      
      expect(scoreActive).toBeGreaterThan(scorePlanned);
      expect(priorityFor(plannedOverdue, today).reasons).toContain("inactive overdue penalty");
    });
  });
});

describe("JSON exchange boundary", () => {
  const valid = () => item({ category: theme.categories[0] });
  const backup = (record: unknown) => JSON.stringify({ schema: 1, records: [record] });

  it("accepts a fully valid record", () => {
    expect(importJson(backup(valid()), theme)).toHaveLength(1);
  });

  it.each([
    ["string effort", { effort: "30" }],
    ["out-of-range impact", { impact: 9 }],
    ["unknown status", { status: "paused" }],
    ["impossible calendar date", { dueDate: "2026-02-30" }],
    ["empty title", { title: "" }],
    ["unknown category", { category: "Not in this project" }],
    ["non-string notes", { notes: 42 }],
    ["invalid timestamp", { updatedAt: "yesterday" }],
    ["numeric-looking loose timestamp", { createdAt: "0" }],
    ["normalized impossible timestamp", { updatedAt: "2026-02-30T00:00:00Z" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => importJson(backup({ ...valid(), ...patch }), theme)).toThrow();
  });

  it("rejects duplicate ids instead of silently merging records", () => {
    const record = valid();
    expect(() => importJson(JSON.stringify({ schema: 1, records: [record, record] }), theme)).toThrow(/duplicate id/);
  });
});
