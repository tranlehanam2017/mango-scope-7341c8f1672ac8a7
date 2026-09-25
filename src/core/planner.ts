import type { LifeRecord, PlanEntry, PlanSummary, ThemeConfig } from "../types";

const DAY_MS = 86_400_000;

const WEIGHTS = {
  IMPACT: 20,
  URGENCY_TODAY: 60,
  URGENCY_NEAR: 30, // 1-3 days away
  URGENCY_WEEK: 15,  // 4-7 days away
  OVERDUE_BASE: 70,
  OVERDUE_DAILY: 5,
  OVERDUE_STAGNATION_KICK: 15, // Boost for items overdue by more than 14 days
  OVERDUE_INACTIVE_PENALTY: 10, // Penalty for overdue items not marked as active
  OVERDUE_IMPACT_MULTIPLIER: 5, // Extra weight per impact point for overdue items
  AT_RISK_MULTIPLIER: 1.3, // Multiplier for high-impact overdue tasks
  CRITICAL_PATH_BOOST: 40, // Boost for high-impact items due today or tomorrow
  ACTIVE_BOOST: 1.25,
  MOMENTUM_BOOST_MAX: 10, // Max boost for items updated just now
  CRITICAL_BOOST: 1.5,
  DISTANT_DECAY_MAX: 10, // Max penalty for items due far in the future
  EFFICIENCY_BOOST: 15, // Bonus for high-impact, low-effort tasks
  FOCUS_BOOST: 50, // Bonus for items matching the selected focus category
  DEPENDENCY_PENALTY: 100, // Significant penalty for blocked items
  BATCHING_BONUS: 5, // Bonus per other item of the same category due soon
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

export function priorityFor(item: LifeRecord, today = localDay(), focusCategory?: string, allItems?: readonly LifeRecord[]): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  
  // Base score from impact
  let score = item.impact * WEIGHTS.IMPACT;
  
  if (daysUntilDue < 0) {
    const absDays = Math.abs(daysUntilDue);
    
    // High-impact overdue items should surface faster than low-impact ones
    const overdueImpactBoost = item.impact * WEIGHTS.OVERDUE_IMPACT_MULTIPLIER;
    score += WEIGHTS.OVERDUE_BASE + overdueImpactBoost + Math.min(absDays, 14) * WEIGHTS.OVERDUE_DAILY;
    
    reasons.push(`${absDays} day(s) overdue`);
    if (item.impact >= 4) reasons.push("high-value overdue");

    // Prevent stagnation: items overdue by more than 2 weeks get a secondary kick
    if (absDays > 14) {
      score += WEIGHTS.OVERDUE_STAGNATION_KICK;
      reasons.push("stagnation boost");
    }

    // Penalty for overdue items that are not actively being worked on
    if (item.status === "planned") {
      score -= WEIGHTS.OVERDUE_INACTIVE_PENALTY;
      reasons.push("inactive overdue penalty");
    }

    // At-Risk Multiplier: Critical overdue tasks get a multiplier to ensure they stay visible
    if (item.impact >= 4) {
      score *= WEIGHTS.AT_RISK_MULTIPLIER;
      reasons.push("at-risk critical");
    }
  } else if (daysUntilDue === 0) {
    score += WEIGHTS.URGENCY_TODAY;
    reasons.push("urgent: due today");
  } else if (daysUntilDue <= 3) {
    score += WEIGHTS.URGENCY_NEAR;
    reasons.push(`due in ${daysUntilDue} day(s)`);
  } else if (daysUntilDue <= 7) {
    score += WEIGHTS.URGENCY_WEEK;
    reasons.push(`due in ${daysUntilDue} day(s)`);
  } else {
    // Decay score for items far in the future to favor closer (though not urgent) items
    const decay = Math.min(WEIGHTS.DISTANT_DECAY_MAX, Math.floor(daysUntilDue / 10));
    score -= decay;
    if (decay > 0) reasons.push("scheduled for future");
  }

  // Critical Path Boost: High-impact items due in the next 48 hours
  if (item.impact >= 4 && daysUntilDue >= 0 && daysUntilDue <= 1) {
    score += WEIGHTS.CRITICAL_PATH_BOOST;
    reasons.push("critical path item");
  }

  // Efficiency Ratio: Bonus for high impact relative to effort (Quick Wins)
  const efficiency = item.impact / item.effort;
  if (efficiency > 0.1) {
    score += WEIGHTS.EFFICIENCY_BOOST;
    reasons.push("quick win");
  }

  // Effort penalty: larger tasks are slightly deprioritized
  let effortPenalty = 0;
  if (item.effort > 90) {
    const excess = item.effort - 90;
    effortPenalty = Math.min(20, Math.sqrt(excess) * 1.2);
  }
  score -= effortPenalty;

  if (item.status === "active") {
    score *= WEIGHTS.ACTIVE_BOOST;
    reasons.push("already in progress");

    const lastUpdated = new Date(item.updatedAt);
    const now = new Date();
    const diffMs = now.getTime() - lastUpdated.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    
    // Linear decay of momentum boost over 48 hours
    if (diffHours < 48) {
      const momentum = WEIGHTS.MOMENTUM_BOOST_MAX * (1 - diffHours / 48);
      score += momentum;
      reasons.push("recent momentum");
    }
  }

  if (item.impact >= 5) {
    score *= WEIGHTS.CRITICAL_BOOST;
    reasons.push("high community value");
  }

  if (focusCategory && item.category === focusCategory) {
    score += WEIGHTS.FOCUS_BOOST;
    reasons.push(`focus: ${focusCategory}`);
  }

  // Dependency Penalty: If this item depends on another that isn't finished, penalize score
  if (item.dependsOn && allItems) {
    const dependency = allItems.find(r => r.id === item.dependsOn);
    if (dependency && dependency.status !== "done" && dependency.status !== "archived") {
      score -= WEIGHTS.DEPENDENCY_PENALTY;
      reasons.push(`blocked by: ${dependency.title}`);
    }
  }

  // Batching Bonus: Encourage working on similar tasks if others in same category are due soon
  if (allItems) {
    const siblings = allItems.filter(r => 
      r.id !== item.id && 
      r.category === item.category && 
      r.status !== "done" && 
      r.status !== "archived" &&
      Math.abs(daysBetween(today, r.dueDate)) <= 3
    );
    if (siblings.length > 0) {
      score += siblings.length * WEIGHTS.BATCHING_BONUS;
      reasons.push(`batching: ${siblings.length} similar tasks`);
    }
  }

  if (item.status === "done" || item.status === "archived") score = -1;
  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue };
}

export function buildPlan(items: readonly LifeRecord[], today = localDay(), focusCategory?: string): PlanEntry[] {
  return items
    .map((item) => priorityFor(item, today, focusCategory, items))
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

export function suggestDailyLoad(items: readonly LifeRecord[], minutesPerDay: number, today = localDay(), saturate = false) {
  const capacity = Math.max(1, minutesPerDay);
  const days = Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10),
    used: 0,
    entries: [] as PlanEntry[],
  }));

  const plan = buildPlan(items, today);

  for (const entry of plan) {
    // If saturating, we prioritize high-score items even if they are due later, as long as they fit
    // If not saturating, we try to keep items near their due date
    const candidates = saturate 
      ? days.filter(d => d.used + entry.item.effort <= capacity * 1.2)
      : days.filter((day, index) => index <= Math.max(0, Math.min(6, entry.daysUntilDue)) && day.used + entry.item.effort <= capacity * 1.1);

    const target = (candidates.length > 0 ? candidates : days).sort((a, b) => a.used - b.used)[0];
    if (!target) continue;
    
    target.entries.push(entry);
    target.used += entry.item.effort;
  }
  return days.map((day) => ({ ...day, overloaded: day.used > capacity }));
}

export function forecastBurnDown(items: readonly LifeRecord[], minutesPerDay: number, today = localDay()) {
  const capacity = Math.max(1, minutesPerDay);
  const pending = items.filter(i => i.status !== "done" && i.status !== "archived");
  const totalEffort = pending.reduce((sum, i) => sum + i.effort, 0);
  
  const daysToComplete = Math.ceil(totalEffort / capacity);
  const completionDate = new Date(Date.parse(`${today}T00:00:00Z`) + daysToComplete * DAY_MS).toISOString().slice(0, 10);

  return {
    totalEffort,
    daysToComplete,
    completionDate,
    averageEffortPerItem: pending.length ? Math.round(totalEffort / pending.length) : 0
  };
}
