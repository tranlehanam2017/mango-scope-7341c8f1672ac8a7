import type { LifeRecord, PlanEntry, PlanSummary, ThemeConfig, EnergyLevel, TimeOfDay } from "../types";

const DAY_MS = 86_400_000;

const WEIGHTS = {
  IMPACT: 20,
  URGENCY_TODAY: 60,
  URGENCY_NEAR: 30, // 1-3 days away
  URGENCY_WEEK: 15,  // 4-7 days away
  OVERDUE_BASE: 70,
  OVERDUE_RECENT_BOOST: 25, // Extra boost for items 1-3 days overdue
  OVERDUE_DAILY: 5,
  OVERDUE_STAGNATION_KICK: 15, // Boost for items overdue by more than 14 days
  OVERDUE_INACTIVE_PENALTY: 10, // Penalty for overdue items not marked as active
  OVERDUE_IMPACT_MULTIPLIER: 5, // Extra weight per impact point for overdue items
  AT_RISK_MULTIPLIER: 1.3, // Multiplier for high-impact overdue tasks
  CRITICAL_PATH_BOOST: 40, // Boost for high-impact items due today or tomorrow
  ACTIVE_BOOST: 1.25,
  MOMENTUM_BOOST_MAX: 15, // Max boost for items updated just now
  CRITICAL_BOOST: 1.5,
  DISTANT_DECAY_MAX: 10, // Max penalty for items due far in the future
  EFFICIENCY_BOOST_MAX: 20, // Max bonus for high-impact, low-effort tasks
  EFFICIENCY_THRESHOLD: 0.15, // Minimum ratio to start receiving boost
  HYPER_EFFICIENCY_THRESHOLD: 0.4, // Ratio for 'Hyper-Quick Win' boost
  HYPER_EFFICIENCY_BOOST: 10, // Additional boost for hyper-efficient tasks
  FOCUS_BOOST: 50, // Bonus for items matching the selected focus category
  FOCUS_INTENSITY_MULTIPLIER: 1.15, // Multiplier for focus category items to amplify other boosts
  DEPENDENCY_PENALTY: 100, // Significant penalty for blocked items
  BATCHING_BONUS: 5, // Bonus per other item of the same category due soon
  QUICK_WIN_BATCH_BONUS: 12, // Higher bonus when batching multiple quick-wins
  BATCH_MOMENTUM_MULTIPLIER: 1.05, // Multiplier per additional item in a category batch
  CAPACITY_FIT_BONUS: 12, // Bonus for tasks that fit well in standard blocks
  DIMENSION_WEIGHT: 12, // Base weight for each additional impact dimension
  STABILITY_THRESHOLD: 0.5, // Minimum score diff to trigger a rank change
  STALE_DECAY_START: 30, // Days after which overdue items start losing priority
  STALE_DECAY_RATE: 2,   // Penalty per day after STALE_DECAY_START
  POSTPONE_PENALTY: 8,   // Penalty per time the item was pushed forward
  POSTPONE_THRESHOLD: 3,  // When churn penalty starts applying
  RISK_EFFORT_THRESHOLD: 120, // Effort above which an overdue task is considered 'at risk' of avoidance
  RISK_BOOST: 25, // Extra boost to surface high-effort overdue tasks
  SUBTASK_BOOST: 15, // Boost for sub-tasks whose parents are critical
  WSJF_SCALING_FACTOR: 25, // Scaling factor for the value density (Cost of Delay / Duration)
  COMPLEXITY_MULTIPLIER: 1.1, // Small boost for nuanced/complex tasks to prevent them being buried
  OVERSIZE_PENALTY_BASE: 15, // Base penalty for tasks exceeding half a standard workday (240m)
  COMPLEXITY_EFFORT_PENALTY: 4, // Penalty per dimension when effort is high
  PREFERENCE_BOOST: 10, // Bonus for alignment with current time/energy context
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

export function snoozeRecord(item: LifeRecord, days: number): LifeRecord {
  const currentDue = new Date(`${item.dueDate}T00:00:00Z`);
  currentDue.setUTCDate(currentDue.getUTCDate() + days);
  
  return {
    ...item,
    dueDate: currentDue.toISOString().slice(0, 10),
    postponedCount: (item.postponedCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
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

  // Multi-dimensional impact boost
  if (item.impactDimensions) {
    const dimCount = Object.keys(item.impactDimensions).length;
    const dimSum = Object.values(item.impactDimensions).reduce((a, b) => a + b, 0);
    
    if (dimCount > 0) {
      const dimBoost = (dimSum * WEIGHTS.DIMENSION_WEIGHT) / (dimCount || 1);
      score += dimBoost;
      reasons.push("multi-dimensional value");
    }
  }
  
  if (daysUntilDue < 0) {
    const absDays = Math.abs(daysUntilDue);
    
    // High-impact overdue items should surface faster than low-impact ones
    const overdueImpactBoost = item.impact * WEIGHTS.OVERDUE_IMPACT_MULTIPLIER;
    score += WEIGHTS.OVERDUE_BASE + overdueImpactBoost + Math.min(absDays, 14) * WEIGHTS.OVERDUE_DAILY;
    
    reasons.push(`${absDays} day(s) overdue`);
    if (item.impact >= 4) reasons.push("high-value overdue");

    // Boost for items only slightly overdue to prioritize rapid recovery
    if (absDays <= 3) {
      score += WEIGHTS.OVERDUE_RECENT_BOOST;
      reasons.push("recent overdue recovery");
    }

    // Prevent stagnation: items overdue by more than 2 weeks get a secondary kick
    if (absDays > 14) {
      score += WEIGHTS.OVERDUE_STAGNATION_KICK;
      reasons.push("stagnation boost");
    }

    // Risk Factor: Large overdue tasks often get pushed because they are intimidating. 
    // We boost them slightly to ensure they don't just vanish from the top of the list.
    if (item.effort > WEIGHTS.RISK_EFFORT_THRESHOLD) {
      // Refined: Only boost high-effort tasks if they also have significant impact, 
      // otherwise we risk surfacing 'bloat' tasks over quick wins.
      if (item.impact >= 3) {
        score += WEIGHTS.RISK_BOOST;
        reasons.push("high-effort risk boost");
      }
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

    // Long-term decay: if a task is extremely overdue and not active, it's likely stale.
    // Gradually reduce priority so the list isn't permanently clogged with old, ignored tasks.
    if (absDays > WEIGHTS.STALE_DECAY_START && item.status !== "active") {
      const staleDays = absDays - WEIGHTS.STALE_DECAY_START;
      const decay = staleDays * WEIGHTS.STALE_DECAY_RATE;
      score -= decay;
      reasons.push(`stale decay (-${decay})`);
    }
  } else if (daysUntilDue === 0) {
    score += WEIGHTS.URGENCY_TODAY;
    reasons.push("urgent: due today");
  } else if (daysUntilDue <= 3) {
    score += WEIGHTS.URGENCY_NEAR;
    reasons.push(`due in ${daysUntilDue} day(s)`);
    
    // Stability Boost: High-impact tasks nearing their deadline should not be easily
    // bumped by new small tasks. We add a small stability weight based on impact.
    if (item.impact >= 4) {
      score += item.impact * 2;
      reasons.push("critical stability boost");
    }
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

  // Refined WSJF-inspired Value Density: (Impact / Effort) * Scale
  // Adjusted: We use a logarithmic dampener for effort to ensure that
  // very high-effort tasks still get some priority if impact is massive.
  const scaledEffort = item.effort > 60 ? 60 + Math.log2(item.effort - 59) * 10 : item.effort;
  const valueDensity = (item.impact / scaledEffort) * WEIGHTS.WSJF_SCALING_FACTOR;
  score += valueDensity;
  if (valueDensity > 8) reasons.push("high value density");

  // Efficiency Ratio: Scaled bonus for high impact relative to effort (Quick Wins)
  const efficiency = item.impact / item.effort;
  const isQuickWin = efficiency > WEIGHTS.EFFICIENCY_THRESHOLD;
  if (isQuickWin) {
    const efficiencyFactor = Math.min(1, (efficiency - WEIGHTS.EFFICIENCY_THRESHOLD) / 0.35);
    score += efficiencyFactor * WEIGHTS.EFFICIENCY_BOOST_MAX;
    reasons.push("quick win");
    
    if (efficiency > WEIGHTS.HYPER_EFFICIENCY_THRESHOLD) {
      score += WEIGHTS.HYPER_EFFICIENCY_BOOST;
      reasons.push("hyper-efficient");
    }
  }

  // Capacity Fit: Small bonus for items that align with common work blocks
  const commonBlocks = [15, 30, 45, 60, 90, 120];
  if (commonBlocks.includes(item.effort)) {
    score += WEIGHTS.CAPACITY_FIT_BONUS;
    reasons.push("optimal time block");
  }

  // Effort penalty: progressive penalty for very large tasks
  let effortPenalty = 0;
  if (item.effort > 60) {
    const excess = item.effort - 60;
    effortPenalty = Math.min(30, Math.log2(excess + 1) * 4);
  }
  
  // Workload-aware penalty for oversized tasks
  if (item.effort > 240) {
    const oversized = item.effort - 240;
    effortPenalty += WEIGHTS.OVERSIZE_PENALTY_BASE + Math.floor(oversized / 60) * 5;
    reasons.push("oversized effort penalty");
  }
  
  score -= effortPenalty;

  if (item.status === "active") {
    score *= WEIGHTS.ACTIVE_BOOST;
    reasons.push("already in progress");

    const lastUpdated = new Date(item.updatedAt);
    const now = new Date();
    const diffMs = now.getTime() - lastUpdated.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    
    if (diffHours < 72) {
      // Linear decay for momentum: it's more predictable than exponential
      const decayFactor = 1 - (diffHours / 72);
      const momentum = WEIGHTS.MOMENTUM_BOOST_MAX * decayFactor;
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
    // Focus Intensity: amplify the total score to make focus items dominate other logic
    score *= WEIGHTS.FOCUS_INTENSITY_MULTIPLIER;
    reasons.push("focus intensity");
  }

  // Dependency Penalty
  if (item.dependsOn && allItems) {
    const dependency = allItems.find(r => r.id === item.dependsOn);
    if (dependency && dependency.status !== "done" && dependency.status !== "archived") {
      score -= WEIGHTS.DEPENDENCY_PENALTY;
      reasons.push(`blocked by: ${dependency.title}`);
    }
  }

  // Sub-task propagation: If this is a sub-task, inherit some value from the parent
  if (item.parentId && allItems) {
    const parent = allItems.find(r => r.id === item.parentId);
    if (parent && parent.status !== "done" && parent.status !== "archived") {
      if (parent.impact >= 4) {
        score += WEIGHTS.SUBTASK_BOOST;
        reasons.push(`sub-task of ${parent.title}`);
      }
    }
  }

  // Batching Bonus & Sequential Momentum
  if (allItems) {
    const siblings = allItems.filter(r => 
      r.id !== item.id && 
      r.category === item.category && 
      r.status !== "done" && 
      r.status !== "archived" &&
      Math.abs(daysBetween(today, r.dueDate)) <= 3
    );
    if (siblings.length > 0) {
      const isBatchingQuickWins = isQuickWin && siblings.some(s => (s.impact / s.effort) > WEIGHTS.EFFICIENCY_THRESHOLD);
      const bonusPerItem = isBatchingQuickWins ? WEIGHTS.QUICK_WIN_BATCH_BONUS : WEIGHTS.BATCHING_BONUS;
      
      score += siblings.length * bonusPerItem;
      
      // Batch Momentum: amplify score slightly for each additional task in the batch
      // to favor grouping tasks of the same category together in the final plan.
      const momentumMult = Math.pow(WEIGHTS.BATCH_MOMENTUM_MULTIPLIER, siblings.length);
      score *= momentumMult;

      reasons.push(`batching: ${siblings.length} similar tasks${isBatchingQuickWins ? ' (quick-win loop)' : ''}`);
      if (siblings.length >= 3) reasons.push("batch momentum");
    }
  }

  // Churn Penalty: Penalize items that have been postponed multiple times
  if (item.postponedCount && item.postponedCount > 0) {
    const count = item.postponedCount;
    const churnPenalty = count < WEIGHTS.POSTPONE_THRESHOLD 
      ? count * (WEIGHTS.POSTPONE_PENALTY / 2) 
      : (count - WEIGHTS.POSTPONE_THRESHOLD + 1) * WEIGHTS.POSTPONE_PENALTY;
    score -= churnPenalty;
    reasons.push(`postponed ${count}x`);
  }

  // Complexity multiplier: Nuanced tasks (those with multiple impact dimensions)
  // get a slight boost to ensure they don't get buried by simple high-impact tasks.
  if (item.impactDimensions && Object.keys(item.impactDimensions).length > 1) {
    score *= WEIGHTS.COMPLEXITY_MULTIPLIER;
    reasons.push("complexity weight");

    // Complexity-to-Effort Penalty: If a task is both complex (many dimensions) 
    // and high-effort, it's a candidate for breaking down. We penalize it slightly 
    // to encourage splitting it into smaller, more manageable sub-tasks.
    if (item.effort > 120) {
      const dimCount = Object.keys(item.impactDimensions).length;
      const complexityPenalty = dimCount * WEIGHTS.COMPLEXITY_EFFORT_PENALTY;
      score -= complexityPenalty;
      reasons.push(`complexity/effort penalty (-${complexityPenalty})`);
    }
  }

  if (item.status === "done" || item.status === "archived") score = -1;
  if (item.status === "stale") {
    score -= 100; // Significant deprioritization for explicitly stale items
    reasons.push("marked as stale");
  }
  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue };
}

export function buildPlan(items: readonly LifeRecord[], today = localDay(), focusCategory?: string): PlanEntry[] {
  const entries = items
    .map((item) => priorityFor(item, today, focusCategory, items))
    .filter((entry) => entry.item.status !== "done" && entry.item.status !== "archived");

  return entries.sort((a, b) => {
    const diff = b.score - a.score;
    
    // Refined stability: Use a threshold to prevent rank-swapping for very similar tasks.
    // High efficiency tasks (quick wins) have a tighter stability window to allow them to move up easier.
    const aEff = a.item.impact / a.item.effort;
    const bEff = b.item.impact / b.item.effort;
    const isQuickWin = aEff > WEIGHTS.EFFICIENCY_THRESHOLD || bEff > WEIGHTS.EFFICIENCY_THRESHOLD;
    const stability = isQuickWin ? WEIGHTS.STABILITY_THRESHOLD * 0.5 : WEIGHTS.STABILITY_THRESHOLD;

    if (Math.abs(diff) < stability) {
      // Tie-break 1: Prefer items due sooner
      const dateDiff = a.item.dueDate.localeCompare(b.item.dueDate);
      if (dateDiff !== 0) return dateDiff;
      
      // Tie-break 2: Prefer items with higher impact
      if (a.item.impact !== b.item.impact) return b.item.impact - a.item.impact;
      
      // Tie-break 3: Deterministic ID sort to prevent unstable lists
      return a.item.id.localeCompare(b.item.id);
    }
    return diff || a.item.dueDate.localeCompare(b.item.dueDate);
  });
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
  const softCapacity = Math.max(1, minutesPerDay);
  const hardCapacity = softCapacity * 1.3;
  
  const days = Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10),
    used: 0,
    energyDistribution: { high: 0, medium: 0, low: 0 },
    timeDistribution: { morning: 0, afternoon: 0, evening: 0 },
    entries: [] as PlanEntry[],
  }));

  const plan = buildPlan(items, today);

  for (const entry of plan) {
    // Strategic Buffering: If the previous day was critically overloaded, 
    // we reduce the capacity for the current day to allow for recovery.
    const getEffectiveCapacity = (dayIndex: number) => {
      if (dayIndex === 0) return hardCapacity;
      const prevDay = days[dayIndex - 1];
      return prevDay.used > hardCapacity ? softCapacity * 0.8 : hardCapacity;
    };

    const candidates = saturate 
      ? days.filter((d, idx) => d.used + entry.item.effort <= getEffectiveCapacity(idx))
      : days.filter((day, index) => 
          index <= Math.max(0, Math.min(6, entry.daysUntilDue)) && 
          day.used + entry.item.effort <= getEffectiveCapacity(index)
        );

    if (candidates.length === 0) continue;

    const target = candidates.sort((a, b) => {
      // Deep Work Preference: For high-effort tasks (>= 90m), favor days that already have high-effort work
      // to consolidate intensive blocks rather than scattering them across the week.
      if (entry.item.effort >= 90) {
        const aDeep = a.entries.some(e => e.item.effort >= 90) ? 0 : 1;
        const bDeep = b.entries.some(e => e.item.effort >= 90) ? 0 : 1;
        if (aDeep !== bDeep) return aDeep - bDeep;
      }

      // Balanced Effort: If the task is medium-to-large, avoid placing it on a day
      // that is already significantly occupied by a single massive task (concentration risk).
      if (entry.item.effort >= 60) {
        const aMax = a.entries.length ? Math.max(...a.entries.map(e => e.item.effort)) : 0;
        const bMax = b.entries.length ? Math.max(...b.entries.map(e => e.item.effort)) : 0;
        if (aMax !== bMax) return aMax - bMax; // Prefer the day with the smaller 'largest' task
      }

      if (entry.item.preferredEnergy) {
        const aEnergy = a.energyDistribution[entry.item.preferredEnergy];
        const bEnergy = b.energyDistribution[entry.item.preferredEnergy];
        if (aEnergy !== bEnergy) return aEnergy - bEnergy;
      }

      const aUnder = a.used < softCapacity ? 0 : 1;
      const bUnder = b.used < softCapacity ? 0 : 1;
      if (aUnder !== bUnder) return aUnder - bUnder;
      
      return a.used - b.used;
    })[0];
    
    target.entries.push(entry);
    target.used += entry.item.effort;
    if (entry.item.preferredEnergy) {
      target.energyDistribution[entry.item.preferredEnergy] += entry.item.effort;
    }
    if (entry.item.preferredTime) {
      target.timeDistribution[entry.item.preferredTime] += entry.item.effort;
    }
  }
  return days.map((day) => ({
    ...day,
    overloaded: day.used > softCapacity,
    criticalOverload: day.used > hardCapacity
  }));
}

export function forecastBurnDown(items: readonly LifeRecord[], minutesPerDay: number, today = localDay()) {
  const capacity = Math.max(1, minutesPerDay);
  const pending = items.filter(i => i.status !== "done" && i.status !== "archived");
  const totalEffort = pending.reduce((sum, i) => sum + i.effort, 0);
  
  const daysToComplete = Math.ceil(totalEffort / capacity);
  const completionDate = new Date(Date.parse(`${today}T00:00:00Z`) + daysToComplete * DAY_MS).toISOString().slice(0, 10);

  const riskEffort = pending.reduce((sum, i) => {
    return sum + (i.effort > 120 ? i.effort * 1.2 : i.effort);
  }, 0);
  const riskDays = Math.ceil(riskEffort / capacity);
  const riskCompletionDate = new Date(Date.parse(`${today}T00:00:00Z`) + riskDays * DAY_MS).toISOString().slice(0, 10);

  const meanEffort = pending.length ? totalEffort / pending.length : 0;
  const variance = pending.length ? pending.reduce((sum, i) => sum + Math.pow(i.effort - meanEffort, 2), 0) / pending.length : 0;
  const stdDev = Math.sqrt(variance);
  
  const volatileEffort = totalEffort + stdDev;
  const volatileDays = Math.ceil(volatileEffort / capacity);
  const volatileCompletionDate = new Date(Date.parse(`${today}T00:00:00Z`) + volatileDays * DAY_MS).toISOString().slice(0, 10);

  const totalImpact = pending.reduce((sum, i) => sum + i.impact, 0);
  const criticalityScore = pending.length ? Math.round((totalImpact / pending.length) * (stdDev / (meanEffort || 1)) * 10) : 0;

  // Confidence Score: Based on the ratio of standard deviation to mean effort.
  // Lower volatility (stdDev) means higher confidence in the completion date.
  const volatilityRatio = meanEffort ? stdDev / meanEffort : 0;
  const confidenceScore = Math.max(0, Math.min(100, Math.round(100 * (1 - volatilityRatio))));

  // Multi-day trend forecast
  const trend = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
    const remaining = Math.max(0, totalEffort - (i + 1) * capacity);
    return { date, remaining };
  });

  return {
    totalEffort,
    daysToComplete,
    completionDate,
    riskDays,
    riskCompletionDate,
    volatileDays,
    volatileCompletionDate,
    averageEffortPerItem: pending.length ? Math.round(totalEffort / pending.length) : 0,
    volatilityScore: pending.length ? Math.round((stdDev / meanEffort) * 100) : 0,
    criticalityScore,
    confidenceScore,
    trend
  };
}

export function forecastBurnUp(items: readonly LifeRecord[], minutesPerDay: number, today = localDay()) {
  const capacity = Math.max(1, minutesPerDay);
  const totalProjectEffort = items.reduce((sum, i) => sum + i.effort, 0);
  const completedEffort = items.filter(i => i.status === "done" || i.status === "archived").reduce((sum, i) => sum + i.effort, 0);
  const pendingEffort = totalProjectEffort - completedEffort;
  
  const daysToComplete = Math.ceil(pendingEffort / capacity);
  const completionDate = new Date(Date.parse(`${today}T00:00:00Z`) + daysToComplete * DAY_MS).toISOString().slice(0, 10);

  // Multi-day trend forecast
  const trend = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
    const completed = Math.min(totalProjectEffort, completedEffort + (i + 1) * capacity);
    return { date, completed };
  });

  return {
    totalProjectEffort,
    completedEffort,
    pendingEffort,
    daysToComplete,
    completionDate,
    progressPercent: totalProjectEffort ? Math.round((completedEffort / totalProjectEffort) * 100) : 0,
    trend
  };
}

export type EisenhowerQuadrant = "DO_FIRST" | "SCHEDULE" | "DELEGATE" | "ELIMINATE";

export function analyzeEisenhower(item: LifeRecord, today = localDay()): EisenhowerQuadrant {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const isUrgent = daysUntilDue <= 2;
  const isImportant = item.impact >= 4;
  const isHighEffort = item.effort > 180;

  if (isUrgent && isImportant) return "DO_FIRST";
  if (!isUrgent && isImportant) return "SCHEDULE";
  if (isUrgent && !isImportant) return "DELEGATE";
  
  // Refinement: High-effort, low-impact tasks are prime candidates for elimination
  if (!isImportant && isHighEffort) return "ELIMINATE";
  
  return "ELIMINATE";
}

export interface RecordFilter {
  search?: string;
  category?: string;
  status?: ItemStatus | ItemStatus[];
  minImpact?: number;
  maxEffort?: number;
  overdueOnly?: boolean;
  urgentOnly?: boolean;
}

export function filterRecords(items: readonly LifeRecord[], filter: RecordFilter, today = localDay()): LifeRecord[] {
  return items.filter(item => {
    if (filter.search) {
      const s = filter.search.toLowerCase();
      if (!item.title.toLowerCase().includes(s) && !item.notes.toLowerCase().includes(s)) return false;
    }
    if (filter.category && item.category !== filter.category) return false;
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(item.status)) return false;
    }
    if (filter.minImpact !== undefined && item.impact < filter.minImpact) return false;
    if (filter.maxEffort !== undefined && item.effort > filter.maxEffort) return false;
    if (filter.overdueOnly && daysBetween(today, item.dueDate) >= 0) return false;
    if (filter.urgentOnly && daysBetween(today, item.dueDate) > 2) return false;
    
    return true;
  });
}
