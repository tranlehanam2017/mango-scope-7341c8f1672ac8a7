import type { LifeRecord } from "../types";
import type { ThemeConfig } from "../types";
import { cloneRecord, isCalendarDay, isTimestamp, hasCycle } from "./records";

export { revisionLedger, type RevisionLedger } from "../generated/revision-ledger";

const MAX_ID_LENGTH = 120;
const VALID_STATUSES = ["planned", "active", "stale", "done", "archived"] as const;
const ENERGY_LEVELS = ["high", "medium", "low"] as const;
const TIMES_OF_DAY = ["morning", "afternoon", "evening"] as const;

function isImportedRecord(value: unknown, theme: ThemeConfig): value is LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.trim().length < 1 || raw.id.length > MAX_ID_LENGTH) return false;
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) return false;
  if (typeof raw.category !== "string" || raw.category.trim().length < 1 || !theme.categories.includes(raw.category)) return false;
  if (!isCalendarDay(raw.dueDate)) return false;
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) return false;
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) return false;
  if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status as (typeof VALID_STATUSES)[number])) return false;
  if (typeof raw.notes !== "string" || raw.notes.length > 600) return false;
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return false;

  if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
    if (typeof raw.dependsOn !== "string" || raw.dependsOn.trim().length < 1 || raw.dependsOn.length > MAX_ID_LENGTH) return false;
  }
  if (raw.parentId !== undefined && raw.parentId !== null) {
    if (typeof raw.parentId !== "string" || raw.parentId.trim().length < 1 || raw.parentId.length > MAX_ID_LENGTH) return false;
  }
  if (raw.impactDimensions !== undefined && raw.impactDimensions !== null) {
    if (!raw.impactDimensions || typeof raw.impactDimensions !== "object" || Array.isArray(raw.impactDimensions)) return false;
    if (Object.keys(raw.impactDimensions).length > 50) return false;
    for (const [key, val] of Object.entries(raw.impactDimensions as Record<string, unknown>)) {
      if (key.trim().length < 1 || key.length > 80) return false;
      if (typeof val !== "number" || !Number.isFinite(val) || val < -1000 || val > 1000) return false;
    }
  }
  if (raw.preferredEnergy !== undefined && raw.preferredEnergy !== null) {
    if (typeof raw.preferredEnergy !== "string" || !ENERGY_LEVELS.includes(raw.preferredEnergy as (typeof ENERGY_LEVELS)[number])) return false;
  }
  if (raw.preferredTime !== undefined && raw.preferredTime !== null) {
    if (typeof raw.preferredTime !== "string" || !TIMES_OF_DAY.includes(raw.preferredTime as (typeof TIMES_OF_DAY)[number])) return false;
  }
  if (raw.postponedCount !== undefined && raw.postponedCount !== null) {
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

  for (const record of records) {
    if (record.dependsOn !== undefined) {
      if (record.dependsOn === record.id) {
        throw new Error("invalid record: self dependency");
      }
      if (!ids.has(record.dependsOn)) {
        throw new Error("invalid record: dangling dependency");
      }
    }
    if (record.parentId !== undefined) {
      if (record.parentId === record.id) {
        throw new Error("invalid record: self parent");
      }
      if (!ids.has(record.parentId)) {
        throw new Error("invalid record: dangling parent");
      }
    }
  }

  const dependencyTargets = new Map(records.map((record) => [record.id, record.dependsOn]));
  const parentTargets = new Map(records.map((record) => [record.id, record.parentId]));
  if (hasCycle(dependencyTargets)) {
    throw new Error("invalid record: cyclic dependency");
  }
  if (hasCycle(parentTargets)) {
    throw new Error("invalid record: cyclic parent");
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
    "impactDimensions", "createdAt", "updatedAt", "dependsOn", "parentId", "preferredEnergy",
    "preferredTime", "postponedCount",
  ];
  const rows = records.map((record) => {
    const normalized = cloneRecord(record);
    return headers
      .map((header) => {
        if (header === "impactDimensions") {
          return csvEscape(normalized.impactDimensions ? JSON.stringify(normalized.impactDimensions) : "");
        }
        return csvEscape(String((normalized as Record<string, unknown>)[header] ?? ""));
      })
      .join(",");
  });
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
  let attached = false;
  try {
    if (document.body) {
      document.body.appendChild(anchor);
      attached = true;
    }
    anchor.click();
  } finally {
    if (attached && anchor.parentNode) {
      try {
        anchor.parentNode.removeChild(anchor);
      } catch {
        /* ignore cleanup failures */
      }
    }
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore cleanup failures */
    }
  }
}

export const download = downloadText;

export { cloneRecord } from "./records";
