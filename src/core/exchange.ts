import type { ItemStatus, LifeRecord, ThemeConfig } from "../types";

export function exportJson(records: readonly LifeRecord[]): string {
  return JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), records }, null, 2);
}

const STATUSES: readonly ItemStatus[] = ["planned", "active", "done"];

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
  // Backups emitted by this app always use UTC. Accept seconds-only input too, but compare the
  // normalized instant so impossible dates (for example February 30) cannot roll into March.
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === canonical;
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
  return {
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
}

export function importJson(source: string, theme: ThemeConfig): LifeRecord[] {
  const parsed = JSON.parse(source) as { schema?: unknown; records?: unknown };
  if (parsed.schema !== 1 || !Array.isArray(parsed.records)) throw new Error("Unsupported backup format.");
  const ids = new Set<string>();
  return parsed.records.map((value, index) => {
    const item = decodeRecord(value, index, theme);
    if (ids.has(item.id)) throw new Error(`Record ${index + 1} has a duplicate id.`);
    ids.add(item.id);
    return item;
  });
}

function csvCell(value: unknown): string { return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`; }

export function exportCsv(records: readonly LifeRecord[]): string {
  const fields: (keyof LifeRecord)[] = ["id", "title", "category", "dueDate", "effort", "impact", "status", "notes"];
  return [fields.join(","), ...records.map((item) => fields.map((field) => csvCell(item[field])).join(","))].join("\n");
}

export function download(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = Object.assign(document.createElement("a"), { href: url, download: name });
  anchor.click();
  URL.revokeObjectURL(url);
}
