import type { LifeRecord, ItemStatus } from "../types";
import { cloneRecord, isCalendarDay, isTimestamp, hasCycle } from "./records";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

const VALID_STATUSES: readonly ItemStatus[] = ["planned", "active", "stale", "done", "archived"];
const ENERGY_LEVELS = ["high", "medium", "low"];
const TIMES_OF_DAY = ["morning", "afternoon", "evening"];
const MAX_ID_LENGTH = 120;

export class RecordStore {
  private readonly listeners = new Set<Listener>();
  private records: LifeRecord[];
  private undoStack: LifeRecord[] | null = null;

  constructor(private readonly key: string, initial: readonly LifeRecord[]) {
    this.records = this.read(initial);
  }

  all(): readonly LifeRecord[] { return this.records.map((item) => cloneRecord(item)); }

  get(id: string): LifeRecord | undefined {
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH) return undefined;
    const found = this.records.find((item) => item.id === id);
    return found ? cloneRecord(found) : undefined;
  }

  has(id: string): boolean {
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH) return false;
    return this.records.some((item) => item.id === id);
  }

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
    if (next.impactDimensions == null) next.impactDimensions = undefined;
    if (next.preferredEnergy == null) next.preferredEnergy = undefined;
    if (next.preferredTime == null) next.preferredTime = undefined;
    if (next.postponedCount == null) next.postponedCount = undefined;
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
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH || !VALID_STATUSES.includes(newStatus)) return;
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

  transitionStatuses(ids: readonly string[], newStatus: ItemStatus): void {
    if (!Array.isArray(ids) || ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= MAX_ID_LENGTH) ||
        !VALID_STATUSES.includes(newStatus)) return;
    const uniqueIds = [...new Set(ids)];
    const idSet = new Set(uniqueIds);
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
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH || !isCalendarDay(newDueDate)) return;
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
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH) return;
    if (dependsOnId !== null && (typeof dependsOnId !== "string" || dependsOnId.trim().length < 1 || dependsOnId.length > MAX_ID_LENGTH)) return;

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
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH) return;
    if (parentId !== null && (typeof parentId !== "string" || parentId.trim().length < 1 || parentId.length > MAX_ID_LENGTH)) return;

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

  removeMany(ids: readonly string[]): void {
    if (!Array.isArray(ids) || ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= MAX_ID_LENGTH)) return;
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
    if (typeof id !== "string" || id.trim().length < 1 || id.length > MAX_ID_LENGTH) return;
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

  replace(records: readonly LifeRecord[]): void {
    if (!Array.isArray(records) || !records.every((record) => isStoredRecord(record))) return;
    if (new Set(records.map((record) => record.id)).size !== records.length) return;
    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records = normalizeStoredRecords(records as LifeRecord[]);
    this.commit();
  }

  private wouldCreateCycle(id: string, targetId: string, relation: "dependsOn" | "parentId"): boolean {
    const field = relation === "dependsOn" ? "dependsOn" : "parentId";
    const seen = new Set<string>();
    let cursor: string | undefined = targetId;
    while (cursor) {
      if (cursor === id) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const record = this.records.find((item) => item.id === cursor);
      cursor = record ? record[field] : undefined;
    }
    return false;
  }

  private read(fallback: readonly LifeRecord[]): LifeRecord[] {
    const removeStored = () => {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(this.key);
      } catch {
        /* ignore storage cleanup failures */
      }
    };

    try {
      if (typeof localStorage === "undefined") return normalizeStoredRecords(fallback);
      const raw = localStorage.getItem(this.key);
      if (raw === null) return normalizeStoredRecords(fallback);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        removeStored();
        return normalizeStoredRecords(fallback);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        removeStored();
        return normalizeStoredRecords(fallback);
      }

      const envelope = parsed as { version?: unknown; records?: unknown };
      if (envelope.version !== 1 || !Array.isArray(envelope.records)) {
        removeStored();
        return normalizeStoredRecords(fallback);
      }

      const records: LifeRecord[] = [];
      const ids = new Set<string>();
      for (const item of envelope.records) {
        if (!isStoredRecord(item)) {
          removeStored();
          return normalizeStoredRecords(fallback);
        }
        const record = cloneRecord(item as LifeRecord);
        if (ids.has(record.id)) {
          removeStored();
          return normalizeStoredRecords(fallback);
        }
        ids.add(record.id);
        records.push(record);
      }

      for (const record of records) {
        if (record.dependsOn !== undefined && !ids.has(record.dependsOn)) {
          removeStored();
          return normalizeStoredRecords(fallback);
        }
        if (record.parentId !== undefined && !ids.has(record.parentId)) {
          removeStored();
          return normalizeStoredRecords(fallback);
        }
        if (record.dependsOn === record.id || record.parentId === record.id) {
          removeStored();
          return normalizeStoredRecords(fallback);
        }
      }

      const parentTargets = new Map(records.map((record) => [record.id, record.parentId]));
      const dependencyTargets = new Map(records.map((record) => [record.id, record.dependsOn]));
      if (hasCycle(parentTargets) || hasCycle(dependencyTargets)) {
        removeStored();
        return normalizeStoredRecords(fallback);
      }

      return records;
    } catch {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(this.key);
      } catch {
        /* ignore storage cleanup failures */
      }
    }
    return normalizeStoredRecords(fallback);
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

export function normalizeStoredRecords(records: readonly LifeRecord[]): LifeRecord[] {
  const ids = new Set(records.map((record) => record.id));
  const cloned = records.map((record) => cloneRecord(record));
  for (const record of cloned) {
    if (record.dependsOn == null) record.dependsOn = undefined;
    if (record.parentId == null) record.parentId = undefined;
    if (record.impactDimensions == null) record.impactDimensions = undefined;
    if (record.preferredEnergy == null) record.preferredEnergy = undefined;
    if (record.preferredTime == null) record.preferredTime = undefined;
    if (record.postponedCount == null) record.postponedCount = undefined;
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

export function isStoredRecord(value: unknown): value is LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.trim().length < 1 || raw.id.length > MAX_ID_LENGTH) return false;
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) return false;
  if (typeof raw.category !== "string" || raw.category.trim().length < 1) return false;
  if (!isCalendarDay(raw.dueDate)) return false;
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) return false;
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) return false;
  if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status as ItemStatus)) return false;
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
    for (const [key, value] of Object.entries(raw.impactDimensions)) {
      if (key.trim().length < 1 || key.length > 80) return false;
      if (typeof value !== "number" || !Number.isFinite(value) || value < -1000 || value > 1000) return false;
    }
  }
  if (raw.preferredEnergy !== undefined && raw.preferredEnergy !== null) {
    if (typeof raw.preferredEnergy !== "string" || !ENERGY_LEVELS.includes(raw.preferredEnergy)) return false;
  }
  if (raw.preferredTime !== undefined && raw.preferredTime !== null) {
    if (typeof raw.preferredTime !== "string" || !TIMES_OF_DAY.includes(raw.preferredTime)) return false;
  }
  if (raw.postponedCount !== undefined && raw.postponedCount !== null) {
    if (typeof raw.postponedCount !== "number" || !Number.isInteger(raw.postponedCount) || raw.postponedCount < 0) return false;
  }
  return true;
}

export { cloneRecord } from "./records";
