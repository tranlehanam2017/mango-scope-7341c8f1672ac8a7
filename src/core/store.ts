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

  all(): readonly LifeRecord[] { return this.records.map((item) => ({ ...item })); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.all());
    return () => this.listeners.delete(listener);
  }

  upsert(record: LifeRecord): void {
    const at = this.records.findIndex((item) => item.id === record.id);
    if (at >= 0) this.records[at] = { ...record };
    else this.records.push({ ...record });
    this.commit();
  }

  /**
   * Transitions a record to a new status and updates the modification timestamp.
   */
  transitionStatus(id: string, newStatus: ItemStatus): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = [{ ...this.records[at] }];

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
      this.undoStack = snapshot;
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
      this.undoStack = snapshot;
      this.commit();
    }
  }

  /**
   * Pushes a record's due date forward and increments the postponement count.
   */
  postpone(id: string, newDueDate: string): void {
    const at = this.records.findIndex((item) => item.id === id);
    if (at === -1) return;

    this.undoStack = [{ ...this.records[at] }];

    this.records[at] = {
      ...this.records[at],
      dueDate: newDueDate,
      postponedCount: (this.records[at].postponedCount || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  undo(): void {
    if (!this.undoStack) return;

    const snapshot = this.undoStack;
    this.undoStack = null;

    // Check if undo is for a deletion or an update
    const currentIds = new Set(this.records.map(r => r.id));
    const deletedItems = snapshot.filter(p => !currentIds.has(p.id));

    if (deletedItems.length > 0 && snapshot.length === deletedItems.length) {
      // Restore deleted items
      this.records = [...this.records, ...snapshot];
    } else {
      // Restore updated items
      this.records = this.records.map(item => {
        const prev = snapshot.find(p => p.id === item.id);
        return prev ? { ...prev } : item;
      });
    }

    this.commit();
  }

  remove(id: string): void {
    this.removeMany([id]);
  }

  clear(): void {
    this.undoStack = this.records.map(r => ({ ...r }));
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