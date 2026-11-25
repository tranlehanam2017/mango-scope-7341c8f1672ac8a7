import type { LifeRecord } from "../types";

export function cloneRecord(record: LifeRecord): LifeRecord {
  return {
    id: record.id,
    title: record.title,
    category: record.category,
    dueDate: record.dueDate,
    effort: record.effort,
    impact: record.impact,
    status: record.status,
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dependsOn: record.dependsOn == null ? undefined : record.dependsOn,
    parentId: record.parentId == null ? undefined : record.parentId,
    impactDimensions: record.impactDimensions == null ? undefined : { ...record.impactDimensions },
    preferredEnergy: record.preferredEnergy == null ? undefined : record.preferredEnergy,
    preferredTime: record.preferredTime == null ? undefined : record.preferredTime,
    postponedCount: record.postponedCount == null ? undefined : record.postponedCount,
  };
}

export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === canonical;
}

export function hasCycle(targets: Map<string, string | undefined>): boolean {
  for (const start of targets.keys()) {
    const seen = new Set<string>([start]);
    let cursor = targets.get(start);
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = targets.get(cursor);
    }
  }
  return false;
}
