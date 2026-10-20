import type { ItemStatus, LifeRecord, ThemeConfig, EnergyLevel, TimeOfDay } from "../types";

export function exportJson(records: readonly LifeRecord[]): string {
  return JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), records }, null, 2);
}

const STATUSES: readonly ItemStatus[] = ["planned", "active", "stale", "done", "archived"];
const ENERGY_LEVELS: readonly EnergyLevel[] = ["high", "medium", "low"];
const TIMES_OF_DAY: readonly TimeOfDay[] = ["morning", "afternoon", "evening"];

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === canonical;
}

function isEnergyLevel(value: unknown): value is EnergyLevel {
  return typeof value === "string" && ENERGY_LEVELS.includes(value as EnergyLevel);
}

function isTimeOfDay(value: unknown): value is TimeOfDay {
  return typeof value === "string" && TIMES_OF_DAY.includes(value as TimeOfDay);
}

function decodeRecord(value: unknown, index: number, theme: ThemeConfig): LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Record ${index + 1} is not an object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 120) {
    throw new Error(`Record ${index + 1} has an invalid id.`);
  }
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) {
    throw new Error(`Record ${index + 1} has an invalid title.`);
  }
  if (typeof raw.category !== "string" || !theme.categories.includes(raw.category)) {
    throw new Error(`Record ${index + 1} has an unknown category.`);
  }
  if (!isCalendarDay(raw.dueDate)) throw new Error(`Record ${index + 1} has an invalid due date.`);
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) {
    throw new Error(`Record ${index + 1} has invalid effort.`);
  }
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) {
    throw new Error(`Record ${index + 1} has invalid impact.`);
  }
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status as ItemStatus)) {
    throw new Error(`Record ${index + 1} has an invalid status.`);
  }
  if (typeof raw.notes !== "string" || raw.notes.length > 600) {
    throw new Error(`Record ${index + 1} has invalid notes.`);
  }
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) {
    throw new Error(`Record ${index + 1} has invalid timestamps.`);
  }

  const record: LifeRecord = {
    id: raw.id,
    title: raw.title.trim(),
    category: raw.category,
    dueDate: raw.dueDate,
    effort: raw.effort,
    impact: raw.impact,
    status: raw.status as ItemStatus,
    notes: raw.notes,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };

  if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
    if (typeof raw.dependsOn !== "string" || raw.dependsOn.length < 1 || raw.dependsOn.length > 120) {
      throw new Error(`Record ${index + 1} has an invalid dependency.`);
    }
    record.dependsOn = raw.dependsOn;
  }
  if (raw.parentId !== undefined && raw.parentId !== null) {
    if (typeof raw.parentId !== "string" || raw.parentId.length < 1 || raw.parentId.length > 120) {
      throw new Error(`Record ${index + 1} has an invalid parent.`);
    }
    record.parentId = raw.parentId;
  }
  if (raw.impactDimensions !== undefined) {
    if (!raw.impactDimensions || typeof raw.impactDimensions !== "object" ||
        Array.isArray(raw.impactDimensions)) {
      throw new Error(`Record ${index + 1} has invalid impact dimensions.`);
    }
    if (Object.keys(raw.impactDimensions).length > 50) {
      throw new Error(`Record ${index + 1} has too many impact dimensions.`);
    }
    const dimensions: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.impactDimensions)) {
      if (key.length < 1 || key.length > 80) {
        throw new Error(`Record ${index + 1} has an invalid impact dimension name.`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < -1000 || value > 1000) {
        throw new Error(`Record ${index + 1} has an invalid impact dimension value.`);
      }
      dimensions[key] = value;
    }
    record.impactDimensions = dimensions;
  }
  if (raw.preferredEnergy !== undefined) {
    if (!isEnergyLevel(raw.preferredEnergy)) {
      throw new Error(`Record ${index + 1} has an invalid energy preference.`);
    }
    record.preferredEnergy = raw.preferredEnergy;
  }
  if (raw.preferredTime !== undefined) {
    if (!isTimeOfDay(raw.preferredTime)) {
      throw new Error(`Record ${index + 1} has an invalid time preference.`);
    }
    record.preferredTime = raw.preferredTime;
  }
  if (raw.postponedCount !== undefined) {
    if (typeof raw.postponedCount !== "number" || !Number.isInteger(raw.postponedCount) || raw.postponedCount < 0) {
      throw new Error(`Record ${index + 1} has an invalid postponement count.`);
    }
    record.postponedCount = raw.postponedCount;
  }

  return record;
}

export function importJson(source: string, theme: ThemeConfig): LifeRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Unsupported backup format.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Unsupported backup format.");
  }
  const envelope = parsed as { schema?: unknown; records?: unknown };
  if (envelope.schema !== 1 || !Array.isArray(envelope.records)) throw new Error("Unsupported backup format.");
  const ids = new Set<string>();
  const records = envelope.records.map((value, index) => {
    const item = decodeRecord(value, index, theme);
    if (ids.has(item.id)) throw new Error(`Record ${index + 1} has a duplicate id.`);
    ids.add(item.id);
    return item;
  });

  for (const [index, record] of records.entries()) {
    if (record.dependsOn === record.id) throw new Error(`Record ${index + 1} cannot depend on itself.`);
    if (record.parentId === record.id) throw new Error(`Record ${index + 1} cannot be its own parent.`);
    if (record.dependsOn !== undefined && !ids.has(record.dependsOn)) {
      throw new Error(`Record ${index + 1} references a missing dependency.`);
    }
    if (record.parentId !== undefined && !ids.has(record.parentId)) {
      throw new Error(`Record ${index + 1} references a missing parent.`);
    }
  }

  const parentTargets = new Map(records.map((record) => [record.id, record.parentId]));
  const dependencyTargets = new Map(records.map((record) => [record.id, record.dependsOn]));
  function hasCycle(targets: Map<string, string | undefined>): boolean {
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
  if (hasCycle(parentTargets)) throw new Error("Record hierarchy contains a cycle.");
  if (hasCycle(dependencyTargets)) throw new Error("Record dependency graph contains a cycle.");

  return records;
}

function csvCell(value: unknown): string { return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`; }

export function exportCsv(records: readonly LifeRecord[]): string {
  const fields: (keyof LifeRecord)[] = ["id", "title", "category", "dueDate", "effort", "impact", "status", "notes"];
  return [fields.join(","), ...records.map((item) => fields.map((field) => csvCell(item[field])).join(","))].join("\n");
}

export function download(name: string, contents: string, type: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = Object.assign(document.createElement("a"), { href: url, download: name });
  anchor.click();
  URL.revokeObjectURL(url);
}
