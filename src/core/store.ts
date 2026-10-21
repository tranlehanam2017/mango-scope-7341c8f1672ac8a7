import type { LifeRecord, ItemStatus } from "../types";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

const VALID_STATUSES: readonly ItemStatus[] = ["planned", "active", "stale", "done", "archived"];
const ENERGY_LEVELS = ["high", "medium", "low"];
const TIMES_OF_DAY = ["morning", "afternoon", "evening"];

export class RecordStore {
  private readonly listeners = new Set<Listener>();
  private records: LifeRecord[];
  private undoStack: LifeRecord[] | null = null;

  constructor(private readonly key: string, initial: LifeRecord[]) {
    this.records = this.read(initial);
  }

  all(): readonly LifeRecord[] { return this.records.map((item) => cloneRecord(item)); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.all());
    return () => this.listeners.delete(listener);
  }

  upsert(record: LifeRecord): void {
    if (!isStoredRecord(record)) return;
    const next = cloneRecord(record);
    if (next.dependsOn == null) next.dependsOn = undefined;
    if (next.parentId == null) next.parentId = undefined;
    if (next.dependsOn === next.id) next.dependsOn = undefined;
    if (next.parentId === next.id) next.parentId = undefined;
    if (next.dependsOn !== undefined && !this.records.some((item) => item.id === next.dependsOn)) {
      next.dependsOn = undefined;
    }
    if (next.parentId !== undefined && !this.records.some((item) => item.id === next.parentId)) {
      next.parentId = undefined;
    }
    if (next.dependsOn !== undefined && this.wouldCreateCycle(next.id, next.dependsOn, "dependsOn")) {
      next.dependsOn = undefined;
    }
    if (next.parentId !== undefined && this.wouldCreateCycle(next.id, next.parentId, "parentId")) {
      next.parentId = undefined;
    }

    const at = this.records.findIndex((item) => item.id === next.id);
    this.undoStack = this.records.map((item) => cloneRecord(item));
    if (at >= 0) {
      this.records[at] = next;
    } else {
      this.records.push(next);
    }
    this.commit();
  }

  transitionStatus(id: string, newStatus: ItemStatus): void {
    if (typeof id !== "string" || id.length < 1 || !VALID_STATUSES.includes(newStatus)) return;
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  transitionStatuses(ids: string[], newStatus: ItemStatus): void {
    if (!Array.isArray(ids) || ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.length > 0) ||
        !VALID_STATUSES.includes(newStatus)) return;
    const idSet = new Set(ids);
    const affected = this.records.filter((item) => idSet.has(item.id));
    if (affected.length === 0) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    const now = new Date().toISOString();
    this.records = this.records.map((item) => (
      idSet.has(item.id)
        ? { ...cloneRecord(item), status: newStatus, updatedAt: now }
        : item
    ));
    this.commit();
  }

  postpone(id: string, newDueDate: string): void {
    if (typeof id !== "string" || id.length < 1 || !isCalendarDay(newDueDate)) return;
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      dueDate: newDueDate,
      postponedCount: (this.records[at].postponedCount || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  setDependency(id: string, dependsOnId: string | null): void {
    if (typeof id !== "string" || id.length < 1) return;
    if (dependsOnId !== null && (typeof dependsOnId !== "string" || dependsOnId.length < 1 || dependsOnId.length > 120)) return;

    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    const normalized = dependsOnId ?? undefined;
    if (normalized === id) return;
    if (normalized !== undefined && !this.records.some((item) => item.id === normalized)) return;
    if (normalized !== undefined && this.wouldCreateCycle(id, normalized, "dependsOn")) return;
    if ((this.records[at].dependsOn ?? undefined) === normalized) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      dependsOn: normalized,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  setParent(id: string, parentId: string | null): void {
    if (typeof id !== "string" || id.length < 1) return;
    if (parentId !== null && (typeof parentId !== "string" || parentId.length < 1 || parentId.length > 120)) return;

    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    const normalized = parentId ?? undefined;
    if (normalized === id) return;
    if (normalized !== undefined && !this.records.some((item) => item.id === normalized)) return;
    if (normalized !== undefined && this.wouldCreateCycle(id, normalized, "parentId")) return;
    if ((this.records[at].parentId ?? undefined) === normalized) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      parentId: normalized,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  removeMany(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.length > 0)) return;
    const idSet = new Set(ids);
    const originalLength = this.records.length;
    const snapshot = this.records.map((item) => cloneRecord(item));

    this.records = this.records.filter((item) => !idSet.has(item.id));
    if (this.records.length === originalLength) return;

    this.undoStack = snapshot;
    this.cleanupAfterRemoval(idSet);
    this.commit();
  }

  protected cleanupAfterRemoval(removed: Set<string>): void {
    this.records = this.records.map((item) => {
      const next = cloneRecord(item);
      if (item.dependsOn !== undefined && removed.has(item.dependsOn)) {
        next.dependsOn = undefined;
      }
      if (item.parentId !== undefined && removed.has(item.parentId)) {
        next.parentId = undefined;
      }
      return next;
    });
  }

  undo(): void {
    if (!this.undoStack) return;

    this.records = this.undoStack.map((item) => cloneRecord(item));
    this.undoStack = null;
    this.commit();
  }

  remove(id: string): void {
    if (typeof id !== "string" || id.length < 1) return;
    this.removeMany([id]);
  }

  clear(): void {
    if (this.records.length === 0) {
      this.commit();
      return;
    }
    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records = [];
    this.commit();
  }

  replace(records: LifeRecord[]): void {
    if (!Array.isArray(records) || !records.every((record) => isStoredRecord(record))) return;
    if (new Set(records.map((record) => record.id)).size !== records.length) return;
    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records = normalizeStoredRecords(records);
    this.commit();
  }

  private wouldCreateCycle(id: string, targetId: string, relation: "dependsOn" | "parentId"): boolean {
    const field = relation === "dependsOn" ? "dependsOn" : "parentId";
    const seen = new Set<string>();
    let cursor: string | undefined = targetId;
    while (cursor) {
      if (cursor === id) return true;
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      const record = this.records.find((item) => item.id === cursor);
      cursor = record ? record[field] : undefined;
    }
    return false;
  }

  private read(fallback: LifeRecord[]): LifeRecord[] {
    const removeStored = () => {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(this.key);
      } catch {
        /* ignore storage cleanup failures */
      }
    };

    try {
      if (typeof localStorage === "undefined") return fallback.map(cloneRecord);
      const raw = localStorage.getItem(this.key);
      if (raw === null) return fallback.map(cloneRecord);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        removeStored();
        return fallback.map(cloneRecord);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        removeStored();
        return fallback.map(cloneRecord);
      }

      const envelope = parsed as { version?: unknown; records?: unknown };
      if (envelope.version !== 1 || !Array.isArray(envelope.records)) {
        removeStored();
        return fallback.map(cloneRecord);
      }

      const records: LifeRecord[] = [];
      const ids = new Set<string>();
      for (const item of envelope.records) {
        if (!isStoredRecord(item)) {
          removeStored();
          return fallback.map(cloneRecord);
        }
        const record = cloneRecord(item as LifeRecord);
        if (ids.has(record.id)) {
          removeStored();
          return fallback.map(cloneRecord);
        }
        ids.add(record.id);
        records.push(record);
      }

      for (const record of records) {
        if (record.dependsOn !== undefined && !ids.has(record.dependsOn)) {
          removeStored();
          return fallback.map(cloneRecord);
        }
        if (record.parentId !== undefined && !ids.has(record.parentId)) {
          removeStored();
          return fallback.map(cloneRecord);
        }
        if (record.dependsOn === record.id || record.parentId === record.id) {
          removeStored();
          return fallback.map(cloneRecord);
        }
      }

      const parentTargets = new Map(records.map((record) => [record.id, record.parentId]));
      const dependencyTargets = new Map(records.map((record) => [record.id, record.dependsOn]));
      if (hasCycle(parentTargets) || hasCycle(dependencyTargets)) {
        removeStored();
        return fallback.map(cloneRecord);
      }

      return records;
    } catch {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(this.key);
      } catch {
        /* ignore storage cleanup failures */
      }
    }
    return fallback.map(cloneRecord);
  }

  private commit(): void {
    const envelope: StoreEnvelope = {
      version: 1,
      records: this.records.map((item) => cloneRecord(item)),
      savedAt: new Date().toISOString(),
    };
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(this.key, JSON.stringify(envelope));
    } catch {
      /* persistence is best-effort; listeners still receive the in-memory state */
    }
    for (const listener of this.listeners) listener(this.all());
  }
}

function cloneRecord(record: LifeRecord): LifeRecord {
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
    impactDimensions: record.impactDimensions ? { ...record.impactDimensions } : undefined,
    preferredEnergy: record.preferredEnergy,
    preferredTime: record.preferredTime,
    postponedCount: record.postponedCount,
  };
}

function normalizeStoredRecords(records: LifeRecord[]): LifeRecord[] {
  const ids = new Set(records.map((record) => record.id));
  const cloned = records.map((record) => cloneRecord(record));
  for (const record of cloned) {
    if (record.dependsOn == null) record.dependsOn = undefined;
    if (record.parentId == null) record.parentId = undefined;
    if (record.dependsOn === record.id) record.dependsOn = undefined;
    if (record.parentId === record.id) record.parentId = undefined;
    if (record.dependsOn !== undefined && !ids.has(record.dependsOn)) record.dependsOn = undefined;
    if (record.parentId !== undefined && !ids.has(record.parentId)) record.parentId = undefined;
  }

  const breakCycles = (field: "dependsOn" | "parentId"): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of cloned) {
        const target = record[field];
        if (target === undefined) continue;
        const seen = new Set<string>([record.id]);
        let cursor: string | undefined = target;
        let cyclic = false;
        while (cursor) {
          if (seen.has(cursor)) { cyclic = true; break; }
          seen.add(cursor);
          cursor = cloned.find((item) => item.id === cursor)?.[field];
        }
        if (cyclic) {
          record[field] = undefined;
          changed = true;
        }
      }
    }
  };
  breakCycles("dependsOn");
  breakCycles("parentId");
  return cloned;
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

function isStoredRecord(value: unknown): value is LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 120) return false;
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) return false;
  if (typeof raw.category !== "string" || raw.category.length < 1) return false;
  if (!isCalendarDay(raw.dueDate)) return false;
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) return false;
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) return false;
  if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status as ItemStatus)) return false;
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
    for (const [key, value] of Object.entries(raw.impactDimensions)) {
      if (key.length < 1 || key.length > 80) return false;
      if (typeof value !== "number" || !Number.isFinite(value) || value < -1000 || value > 1000) return false;
    }
  }
  if (raw.preferredEnergy !== undefined) {
    if (typeof raw.preferredEnergy !== "string" || !ENERGY_LEVELS.includes(raw.preferredEnergy)) return false;
  }
  if (raw.preferredTime !== undefined) {
    if (typeof raw.preferredTime !== "string" || !TIMES_OF_DAY.includes(raw.preferredTime)) return false;
  }
  if (raw.postponedCount !== undefined) {
    if (typeof raw.postponedCount !== "number" || !Number.isInteger(raw.postponedCount) || raw.postponedCount < 0) return false;
  }
  return true;
}

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
