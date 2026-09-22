import type { LifeRecord, PlanEntry, PlanSummary, ThemeConfig } from "../types";

const DAY_MS = 86_400_000;

const WEIGHTS = {
  IMPACT: 20,
  URGENCY_TODAY: 60,
  URGENCY_WEEK: 40,
  OVERDUE_BASE: 70,
  OVERDUE_DAILY: 5,
  OVERDUE_STAGNATION_KICK: 15, // Boost for items overdue by more than 14 days
  ACTIVE_BOOST: 1.25,
  CRITICAL_BOOST: 1.5,
  DISTANT_DECAY_MAX: 10, // Max penalty for items due far in the future
};

export function localDay(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.round((end - start) / DAY_MS);
}

export function validateRecord(input: Partial<LifeRecord>, theme: ThemeConfig): string[] {
  const errors: string[] = [];
  if (!input.title?.trim()) errors.push(`${theme.itemLabel} needs a title.`);
  if (!input.category || !theme.categories.includes(input.category)) errors.push("Choose a valid category.");
  if (!input.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) errors.push("Choose a valid date.");
  if (!Number.isFinite(input.effort) || Number(input.effort) < 1 || Number(input.effort) > 480) {
    errors.push(`${theme.effortLabel} must be between 1 and 480.`);
  }
  if (!Number.isInteger(input.impact) || Number(input.impact) < 1 || Number(input.impact) > 5) {
    errors.push(`${theme.impactLabel} must be an integer from 1 to 5.`);
  }
  return errors;
}

export function priorityFor(item: LifeRecord, today = localDay()): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  
  // Base score from impact
  let score = item.impact * WEIGHTS.IMPACT;
  
  if (daysUntilDue < 0) {
    const absDays = Math.abs(daysUntilDue);
    score += WEIGHTS.OVERDUE_BASE + Math.min(absDays, 14) * WEIGHTS.OVERDUE_DAILY;
    reasons.push(`${absDays} day(s) overdue`);

    // Prevent stagnation: items overdue by more than 2 weeks get a secondary kick
    if (absDays > 14) {
      score += WEIGHTS.OVERDUE_STAGNATION_KICK;
      reasons.push("stagnation boost");
    }
  } else if (daysUntilDue === 0) {
    score += WEIGHTS.URGENCY_TODAY;
    reasons.push("urgent: due today");
  } else if (daysUntilDue <= 7) {
    score += WEIGHTS.URGENCY_WEEK - (daysUntilDue * 5);
    reasons.push(`due in ${daysUntilDue} day(s)`);
  } else {
    // Decay score for items far in the future to favor closer (though not urgent) items
    const decay = Math.min(WEIGHTS.DISTANT_DECAY_MAX, Math.floor(daysUntilDue / 10));
    score -= decay;
    if (decay > 0) reasons.push("scheduled for future");
  }

  // Effort penalty: larger tasks are slightly deprioritized
  const effortPenalty = Math.max(0, Math.min((item.effort - 30) / 10, 15));
  score -= effortPenalty;

  if (item.status === "active") {
    score *= WEIGHTS.ACTIVE_BOOST;
    reasons.push("already in progress");
  }

  // Critical item boost: High impact items get a multiplier to prevent them from being buried by effort penalties
  if (item.impact >= 5) {
    score *= WEIGHTS.CRITICAL_BOOST;
    reasons.push("high community value");
  }

  if (item.status === "done" || item.status === "archived") score = -1;
  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue };
}

export function buildPlan(items: readonly LifeRecord[], today = localDay()): PlanEntry[] {
  return items
    .map((item) => priorityFor(item, today))
    .filter((entry) => entry.item.status !== "done" && entry.item.status !== "archived")
    .sort((a, b) => b.score - a.score || a.item.dueDate.localeCompare(b.item.dueDate));
}

export function summarize(items: readonly LifeRecord[], today = localDay()): PlanSummary {
  return items.reduce<PlanSummary>((summary, item) => {
    summary.total += 1;
    const isFinished = item.status === "done" || item.status === "archived";
    summary.effort += isFinished ? 0 : item.effort;
    summary.completed += isFinished ? 1 : 0;
    const days = daysBetween(today, item.dueDate);
    summary.overdue += (!isFinished && days < 0) ? 1 : 0;
    summary.dueSoon += (!isFinished && days >= 0 && days <= 7) ? 1 : 0;
    summary.byCategory[item.category] = (summary.byCategory[item.category] ?? 0) + 1;
    return summary;
  }, { total: 0, completed: 0, overdue: 0, dueSoon: 0, effort: 0, byCategory: {} });
}

export function suggestDailyLoad(items: readonly LifeRecord[], minutesPerDay: number, today = localDay()) {
  const capacity = Math.max(1, minutesPerDay);
  const days = Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10),
    used: 0,
    entries: [] as PlanEntry[],
  }));
  for (const entry of buildPlan(items, today)) {
    const candidates = days.filter((day, index) => index <= Math.max(0, Math.min(6, entry.daysUntilDue)));
    const target = (candidates.length > 0 ? candidates : days).sort((a, b) => a.used - b.used)[0];
    if (!target) continue;
    target.entries.push(entry);
    target.used += entry.item.effort;
  }
  return days.map((day) => ({ ...day, overloaded: day.used > capacity }));
}
