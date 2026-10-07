export type ItemStatus = "planned" | "active" | "stale" | "done" | "archived";

export type EnergyLevel = "high" | "medium" | "low";
export type TimeOfDay = "morning" | "afternoon" | "evening";

export interface LifeRecord {
  id: string;
  title: string;
  category: string;
  dueDate: string;
  effort: number;
  impact: number;
  status: ItemStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
  dependsOn?: string; // ID of the record that must be completed first
  parentId?: string; // ID of the parent task if this is a sub-task
  impactDimensions?: Record<string, number>; // Extra nuanced impact multipliers
  preferredEnergy?: EnergyLevel; // Hint for when to schedule this task
  preferredTime?: TimeOfDay; // Hint for time of day
  postponedCount?: number; // Number of times the due date was pushed forward
}

export interface ThemeConfig {
  readonly id: string;
  readonly product: string;
  readonly tagline: string;
  readonly itemLabel: string;
  readonly dateLabel: string;
  readonly effortLabel: string;
  readonly impactLabel: string;
  readonly categories: readonly string[];
  readonly categoryColors: Readonly<Record<string, string>>;
  readonly seeds: readonly (readonly [string, string, number, number])[];
}

export interface PlanEntry {
  item: LifeRecord;
  score: number;
  reasons: string[];
  daysUntilDue: number;
}

export interface PlanSummary {
  total: number;
  completed: number;
  overdue: number;
  dueSoon: number;
  effort: number;
  byCategory: Record<string, number>;
}

export interface DailyLoadSuggestion {
  date: string;
  used: number;
  overloaded: boolean;
  criticalOverload: boolean;
  energyDistribution: Record<EnergyLevel, number>;
  timeDistribution: Record<TimeOfDay, number>;
  energyConsumed: number;
  energyBudget: number;
  entries: PlanEntry[];
}
