import type { LifeRecord, ItemStatus } from "../types";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

export class RecordStore {
  private readonly listeners = new Set<Listener>();
  private records: LifeRecord[];
  private undoStack: { type: 'update' | 'delete'; data: LifeRecord[] } | null = null;

  constructor(private readonly key: string, initial: LifeRecord[]) {
    this.records = this.read(initial);
  }

  all(): readonly LifeRecord[] { return this.records.map((item) => ({ ...item })); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.all());
    return () => this.listeners.delete(listener);
  }

  upsert(record: LifeRecord): void {
    const at = this.records.findIndex((item) => item.id === record.id);
    if (at >= 0) {
      this.undoStack = { type: 'update', data: [{ ...this.records[at] }] };
      this.records[at] = { ...record };
    } else {
      this.records.push({ ...record });
    }
    this.commit();
  }

  /**
   * Transitions a record to a new status and updates the modification timestamp.
   */
  transitionStatus(id: string, newStatus: ItemStatus): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = { type: 'update', data: [{ ...this.records[at] }] };

    this.records[at] = {
      ...this.records[at],
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
    let changed = false;
    const now = new Date().toISOString();
    const snapshot: LifeRecord[] = [];

    this.records = this.records.map((item) => {
      if (idSet.has(item.id)) {
        changed = true;
        snapshot.push({ ...item });
        return { ...item, status: newStatus, updatedAt: now };
      }
      return item;
    });

    if (changed) {
      this.undoStack = { type: 'update', data: snapshot };
      this.commit();
    }
  }

  /**
   * Removes multiple records by ID.
   */
  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    const snapshot: LifeRecord[] = [];
    const originalLength = this.records.length;

    this.records = this.records.filter((item) => {
      if (idSet.has(item.id)) {
        snapshot.push({ ...item });
        return false;
      }
      return true;
    });

    if (this.records.length !== originalLength) {
      this.undoStack = { type: 'delete', data: snapshot };
      this.commit();
    }
  }

  /**
   * Pushes a record's due date forward and increments the postponement count.
   */
  postpone(id: string, newDueDate: string): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = { type: 'update', data: [{ ...this.records[at] }] };

    this.records[at] = {
      ...this.records[at],
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

    this.undoStack = { type: 'update', data: [{ ...this.records[at] }] };

    this.records[at] = {
      ...this.records[at],
      dependsOn: dependsOnId,
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

    this.undoStack = { type: 'update', data: [{ ...this.records[at] }] };

    this.records[at] = {
      ...this.records[at],
      parentId: parentId,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  undo(): void {
    if (!this.undoStack) return;

    const { type, data } = this.undoStack;
    this.undoStack = null;

    if (type === 'delete') {
      this.records = [...this.records, ...data];
    } else {
      const updateMap = new Map(data.map(item => [item.id, item]));
      this.records = this.records.map(item => {
        const prev = updateMap.get(item.id);
        return prev ? { ...prev } : item;
      });
    }

    this.commit();
  }

  remove(id: string): void {
    this.removeMany([id]);
  }

  clear(): void {
    this.undoStack = { type: 'delete', data: this.records.map(r => ({ ...r })) };
    this.records = [];
    this.commit();
  }

  replace(records: LifeRecord[]): void {
    this.records = records.map((item) => ({ ...item }));
    this.commit();
  }

  private read(fallback: LifeRecord[]): LifeRecord[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.key) ?? "null") as StoreEnvelope | null;
      if (parsed?.version === 1 && Array.isArray(parsed.records)) return parsed.records;
    } catch {
      localStorage.removeItem(this.key);
    }
    return fallback;
  }

  private commit(): void {
    const envelope: StoreEnvelope = { version: 1, records: this.records, savedAt: new Date().toISOString() };
    localStorage.setItem(this.key, JSON.stringify(envelope));
    for (const listener of this.listeners) listener(this.all());
  }
}