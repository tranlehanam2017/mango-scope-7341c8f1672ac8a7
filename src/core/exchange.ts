import type { LifeRecord } from "../types";
import type { ThemeConfig } from "../types";

export { revisionLedger, type RevisionLedger } from "../generated/revision-ledger";

const VALID_STATUSES = ["planned", "active", "stale", "done", "archived"] as const;
const ENERGY_LEVELS = ["high", "medium", "low"] as const;
const TIMES_OF_DAY = ["morning", "afternoon", "evening"] as const;

function cloneRecord(record: LifeRecord): LifeRecord {
  return {
    ...record,
    dependsOn: record.dependsOn == null ? undefined : record.dependsOn,
    parentId: record.parentId == null ? undefined : record.parentId,
    impactDimensions: record.impactDimensions ? { ...record.impactDimensions } : undefined,
  };
}

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

function isImportedRecord(value: unknown, theme: ThemeConfig): value is LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 120) return false;
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) return false;
  if (typeof raw.category !== "string" || !theme.categories.includes(raw.category)) return false;
  if (!isCalendarDay(raw.dueDate)) return false;
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) return false;
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) return false;
  if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status as (typeof VALID_STATUSES)[number])) return false;
  if (typeof raw.notes !== "string" || raw.notes.length > 600) return false;
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return false;

  if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
    if (typeof raw.dependsOn !== "string" || raw.dependsOn.length < 1 || raw.dependsOn.length > 120) return false;
  }
  if (raw.parentId !== undefined && raw.parentId !== null) {
    if (typeof raw.parentId !== "string" || raw.parentId.length < 1 || raw.parentId.length > 120) return false;
  }
  if (raw.impactDimensions !== undefined) {
    if (!raw.impactDimensions || typeof raw.impactDimensions !== "object" || Array.isArray(raw.impactDimensions)) return false;
    if (Object.keys(raw.impactDimensions).length > 50) return false;
    for (const [key, val] of Object.entries(raw.impactDimensions as Record<string, unknown>)) {
      if (key.length < 1 || key.length > 80) return false;
      if (typeof val !== "number" || !Number.isFinite(val) || val < -1000 || val > 1000) return false;
    }
  }
  if (raw.preferredEnergy !== undefined) {
    if (typeof raw.preferredEnergy !== "string" || !ENERGY_LEVELS.includes(raw.preferredEnergy as (typeof ENERGY_LEVELS)[number])) return false;
  }
  if (raw.preferredTime !== undefined) {
    if (typeof raw.preferredTime !== "string" || !TIMES_OF_DAY.includes(raw.preferredTime as (typeof TIMES_OF_DAY)[number])) return false;
  }
  if (raw.postponedCount !== undefined) {
    if (typeof raw.postponedCount !== "number" || !Number.isInteger(raw.postponedCount) || raw.postponedCount < 0) return false;
  }
  return true;
}

export function importJson(raw: string, theme: ThemeConfig): LifeRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid backup envelope");
  }
  const envelope = parsed as { schema?: unknown; records?: unknown };
  if (envelope.schema !== 1) {
    throw new Error("unsupported schema version");
  }
  if (!Array.isArray(envelope.records)) {
    throw new Error("records must be an array");
  }

  const ids = new Set<string>();
  const records: LifeRecord[] = [];
  for (const item of envelope.records) {
    if (!isImportedRecord(item, theme)) {
      throw new Error("invalid record");
    }
    const record = cloneRecord(item as LifeRecord);
    if (ids.has(record.id)) {
      throw new Error(`duplicate id: ${record.id}`);
    }
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

export function exportJson(records: readonly LifeRecord[]): string {
  return JSON.stringify(
    { schema: 1, records: records.map((record) => cloneRecord(record)) },
    null,
    2,
  );
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportCsv(records: readonly LifeRecord[]): string {
  const headers = [
    "id", "title", "category", "dueDate", "effort", "impact", "status", "notes",
    "createdAt", "updatedAt", "dependsOn", "parentId", "preferredEnergy",
    "preferredTime", "postponedCount",
  ];
  const rows = records.map((record) =>
    headers
      .map((header) => csvEscape(String((record as Record<string, unknown>)[header] ?? "")))
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

export const parseJson = importJson;
export const toJson = exportJson;
export const toCsv = exportCsv;

export function downloadText(filename: string, content: string, mimeType = "text/plain"): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
