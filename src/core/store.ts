import type { LifeRecord, ItemStatus } from "../types";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

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
    const at = this.records.findIndex((item) => item.id === record.id);
    this.undoStack = this.records.map((item) => cloneRecord(item));
    if (at >= 0) {
      this.records[at] = cloneRecord(record);
    } else {
      this.records.push(cloneRecord(record));
    }
    this.commit();
  }

  /**
   * Transitions a record to a new status and updates the modification timestamp.
   */
  transitionStatus(id: string, newStatus: ItemStatus): void {
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

  /**
   * Transitions multiple records to a new status and updates timestamps.
   */
  transitionStatuses(ids: string[], newStatus: ItemStatus): void {
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

  /**
   * Pushes a record's due date forward and increments the postponement count.
   */
  postpone(id: string, newDueDate: string): void {
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

  /**
   * Sets a dependency for a record.
   */
  setDependency(id: string, dependsOnId: string | null): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    const normalized = dependsOnId ?? undefined;
    if (normalized === id) return;
    if (normalized !== undefined && !this.records.some((item) => item.id === normalized)) return;
    if (normalized !== undefined && this.wouldCreateCycle(id, normalized, "dependsOn")) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      dependsOn: normalized,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  /**
   * Sets a parent for a record to create a hierarchy.
   */
  setParent(id: string, parentId: string | null): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    const normalized = parentId ?? undefined;
    if (normalized === id) return;
    if (normalized !== undefined && !this.records.some((item) => item.id === normalized)) return;
    if (normalized !== undefined && this.wouldCreateCycle(id, normalized, "parentId")) return;

    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records[at] = {
      ...cloneRecord(this.records[at]),
      parentId: normalized,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  /**
   * Removes multiple records by ID, cleans up dangling relationships, and restores all of that state on undo.
   */
  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    const originalLength = this.records.length;
    const snapshot = this.records.map((item) => cloneRecord(item));

    this.records = this.records.filter((item) => !idSet.has(item.id));
    if (this.records.length === originalLength) return;

    this.undoStack = snapshot;
    this.cleanupAfterRemoval(idSet);
    this.commit();
  }

  /**
   * Cleans dangling relationship references after records have been removed.
   */
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
    this.undoStack = this.records.map((item) => cloneRecord(item));
    this.records = records.map((item) => cloneRecord(item));
    this.commit();
  }

  private wouldCreateCycle(id: string, targetId: string, relation: "dependsOn" | "parentId"): boolean {
    const targets = new Map(this.records.map((item) => [
      item.id,
      relation === "dependsOn" ? item.dependsOn : item.parentId,
    ]));
    targets.set(id, targetId);

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

  private read(fallback: LifeRecord[]): LifeRecord[] {
    try {
      if (typeof localStorage === "undefined") return fallback.map(cloneRecord);
      const raw = localStorage.getItem(this.key);
      if (raw === null) return fallback.map(cloneRecord);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        try {
          localStorage.removeItem(this.key);
        } catch {
          /* ignore storage cleanup failures */
        }
        return fallback.map(cloneRecord);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        try {
          localStorage.removeItem(this.key);
        } catch {
          /* ignore storage cleanup failures */
        }
        return fallback.map(cloneRecord);
      }

      const envelope = parsed as { version?: unknown; records?: unknown };
      if (envelope.version !== 1 || !Array.isArray(envelope.records)) {
        try {
          localStorage.removeItem(this.key);
        } catch {
          /* ignore storage cleanup failures */
        }
        return fallback.map(cloneRecord);
      }

      const records: LifeRecord[] = [];
      for (const item of envelope.records) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          try {
            localStorage.removeItem(this.key);
          } catch {
            /* ignore storage cleanup failures */
          }
          return fallback.map(cloneRecord);
        }
        records.push(cloneRecord(item as LifeRecord));
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
    ...record,
    impactDimensions: record.impactDimensions ? { ...record.impactDimensions } : undefined,
  };
}
