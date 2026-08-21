export type ItemStatus = "planned" | "active" | "done";

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
