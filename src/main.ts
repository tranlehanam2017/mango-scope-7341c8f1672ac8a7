import "./style.css";
import { exportCsv, exportJson, importJson, download } from "./core/exchange";
import { buildPlan, localDay, suggestDailyLoad, summarize, validateRecord } from "./core/planner";
import { RecordStore } from "./core/store";
import { revisionLedger } from "./generated/revision-ledger";
import { theme } from "./theme";
import type { ItemStatus, LifeRecord } from "./types";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Application root is missing.");

const offsetDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const initial: LifeRecord[] = theme.seeds.map(([title, category, effort, impact], index) => ({
  id: crypto.randomUUID(), title, category, effort, impact,
  dueDate: offsetDay(index + 1), status: index === 0 ? "active" : "planned", notes: "",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}));
const store = new RecordStore(`life-board:${theme.id}:v1`, initial);
let selectedCategory = "all";
let searchQuery = "";
let showCompleted = false;
let activeOnly = false;
let showArchived = false;

// Undo state
let lastDeletedRecord: LifeRecord | null = null;
let lastEditedRecord: LifeRecord | null = null;
let undoTimeout: number | null = null;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);

root.innerHTML = `
  <header class="hero"><div><span class="eyebrow">Local-first planning studio</span><h1>${theme.product}</h1>
    <p>${theme.tagline}</p></div><div class="revision" title="Repository revision ledger">
    <span>revision</span><strong>${revisionLedger.ordinal}</strong><small>${revisionLedger.day}</small></div></header>
  <section id="summary" class="summary"></section>
  <main class="layout"><section class="panel"><div class="panel-title"><h2>Add ${theme.itemLabel.toLowerCase()}</h2><div class="panel-actions"><button id="seed-export" class="ghost">Export JSON</button><button id="clear-form" class="ghost">Clear Form</button></div></div><form id="record-form" novalidate>
    <label>Title<input name="title" maxlength="100" required></label>
    <div class="form-grid"><label>Category
      <div class="category-pills">
        ${theme.categories.map(cat => `<button type="button" class="pill" data-cat="${cat}">${cat}</button>`).join('')}
      </div>
      <select name="category">${theme.categories.map((x) => `<option>${x}</option>`).join("")}</select>
    </label>
    <label>${theme.dateLabel}<input name="dueDate" type="date" value="${localDay()}" required></label>
    <label>${theme.effortLabel}
      <div class="effort-presets">
        ${[15, 30, 60, 120].map(m => `<button type="button" class="preset-btn" data-mins="${m}">${m}m</button>`).join('')}
      </div>
      <input name="effort" type="number" min="1" max="480" value="30" required></label>
    <label>${theme.impactLabel}<input name="impact" type="number" min="1" max="5" value="3" required></label></div>
    <label>Notes<textarea name="notes" rows="3" maxlength="600"></textarea></label><p id="errors" class="errors"></p>
    <button type="submit">Add to plan</button></form><div class="exchange"><button id="csv" class="ghost">Export CSV</button>
    <label class="file">Import JSON<input id="import" type="file" accept="application/json"></label>
    <button id="clear-all" class="ghost danger">Clear All</button></div></section>
  <section class="panel plan-panel"><div class="panel-title"><h2>Priority plan</h2><div class="filter-group"><div class="search-wrap"><input id="search" placeholder="Search records..."><button id="clear-search" class="ghost search-clear">×</button></div><select id="filter"><option value="all">All categories</option>
    ${theme.categories.map((x) => `<option>${x}</option>`).join("")}</select><label class="checkbox-label"><input id="show-completed" type="checkbox"> Show done</label><label class="checkbox-label"><input id="active-only" type="checkbox"> Active only</label><label class="checkbox-label"><input id="show-archived" type="checkbox"> Show archived</label><button id="clear-filters" class="ghost">Clear filters</button></div></div><div id="bulk-actions" class="bulk-actions"></div><div id="plan"></div></section></main>
  <section class="panel week-panel"><div class="panel-title"><h2>Seven-day load</h2><label>Daily capacity
    <input id="capacity" type="number" min="15" max="480" step="15" value="90"></label></div><div id="week" class="week"></div></section>
  <div id="undo-toast" class="undo-toast"></div>
`;

const form = document.querySelector<HTMLFormElement>("#record-form")!;
const errors = document.querySelector<HTMLParagraphElement>("#errors")!;
const capacity = document.querySelector<HTMLInputElement>("#capacity")!;
const undoToast = document.querySelector<HTMLDivElement>("#undo-toast")!;

function showUndo(record: LifeRecord, type: 'deleted' | 'edited') {
  if (type === 'deleted') lastDeletedRecord = record;
  else lastEditedRecord = record;

  undoToast.innerHTML = `<span>${type === 'deleted' ? 'Deleted' : 'Updated'} "${escapeHtml(record.title)}"</span><button id="undo-btn">Undo</button>`;
  undoToast.classList.add("visible");
  
  if (undoTimeout) clearTimeout(undoTimeout);
  undoTimeout = window.setTimeout(() => {
    undoToast.classList.remove("visible");
    lastDeletedRecord = null;
    lastEditedRecord = null;
  }, 8000);

  document.querySelector("#undo-btn")!.onclick = () => {
    if (type === 'deleted' && lastDeletedRecord) {
      store.upsert(lastDeletedRecord);
    } else if (type === 'edited' && lastEditedRecord) {
      store.upsert(lastEditedRecord);
    }
    undoToast.classList.remove("visible");
    lastDeletedRecord = null;
    lastEditedRecord = null;
  };
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const now = new Date().toISOString();
  const item: LifeRecord = {
    id: crypto.randomUUID(), title: String(data.get("title") ?? "").trim(),
    category: String(data.get("category") ?? ""), dueDate: String(data.get("dueDate") ?? ""),
    effort: Number(data.get("effort")), impact: Number(data.get("impact")), status: "planned",
    notes: String(data.get("notes") ?? "").trim(), createdAt: now, updatedAt: now,
  };
  const complaints = validateRecord(item, theme);
  if (complaints.length) { errors.textContent = complaints.join(" "); return; }
  errors.textContent = ""; store.upsert(item); form.reset();
  (form.elements.namedItem("dueDate") as HTMLInputElement).value = localDay();
  (form.elements.namedItem("title") as HTMLInputElement).focus();
});

// Quick-category and Quick-effort buttons
form.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.classList.contains("pill")) {
    const category = target.dataset.cat;
    const select = form.elements.namedItem("category") as HTMLSelectElement;
    if (category) select.value = category;
  }
  if (target.classList.contains("preset-btn")) {
    const mins = target.dataset.mins;
    const input = form.elements.namedItem("effort") as HTMLInputElement;
    if (mins) input.value = mins;
  }
});

document.querySelector("#clear-form")!.addEventListener("click", () => {
  form.reset();
  (form.elements.namedItem("dueDate") as HTMLInputElement).value = localDay();
  errors.textContent = "";
});

document.querySelector<HTMLSelectElement>("#filter")!.addEventListener("change", (event) => {
  selectedCategory = (event.target as HTMLSelectElement).value;
  render(store.all());
});

document.querySelector<HTMLInputElement>("#search")!.addEventListener("input", (event) => {
  searchQuery = (event.target as HTMLInputElement).value.toLowerCase().trim();
  render(store.all());
});

document.querySelector<HTMLButtonElement>("#clear-search")!.addEventListener("click", () => {
  const searchInput = document.querySelector<HTMLInputElement>("#search")!;
  searchInput.value = "";
  searchQuery = "";
  render(store.all());
  searchInput.focus();
});

document.querySelector<HTMLInputElement>("#show-completed")!.addEventListener("change", (event) => {
  showCompleted = (event.target as HTMLInputElement).checked;
  render(store.all());
});

document.querySelector<HTMLInputElement>("#active-only")!.addEventListener("change", (event) => {
  activeOnly = (event.target as HTMLInputElement).checked;
  render(store.all());
});

document.querySelector<HTMLInputElement>("#show-archived")!.addEventListener("change", (event) => {
  showArchived = (event.target as HTMLInputElement).checked;
  render(store.all());
});

capacity.addEventListener("input", () => render(store.all()));
document.querySelector("#seed-export")!.addEventListener("click", () => download("records.json", exportJson(store.all()), "application/json"));
document.querySelector("#csv")!.addEventListener("click", () => download("records.csv", exportCsv(store.all()), "text/csv"));
document.querySelector<HTMLInputElement>("#import")!.addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try { store.replace(importJson(await file.text(), theme)); errors.textContent = ""; }
  catch (error) { errors.textContent = error instanceof Error ? error.message : "Import failed."; }
});
document.querySelector("#clear-all")!.addEventListener("click", () => {
  const records = store.all();
  if (records.length === 0) return;
  if (confirm(`Warning: This will permanently delete all ${records.length} records from your local storage. Are you sure you want to proceed?`)) store.clear();
});

document.querySelector("#clear-filters")!.addEventListener("click", () => {
  selectedCategory = "all";
  searchQuery = "";
  showCompleted = false;
  activeOnly = false;
  showArchived = false;
  
  (document.querySelector("#filter") as HTMLSelectElement).value = "all";
  (document.querySelector("#search") as HTMLInputElement).value = "";
  (document.querySelector("#show-completed") as HTMLInputElement).checked = false;
  (document.querySelector("#active-only") as HTMLInputElement).checked = false;
  (document.querySelector("#show-archived") as HTMLInputElement).checked = false;
  
  render(store.all());
});

// Keyboard shortcuts
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "n") {
    event.preventDefault();
    (form.elements.namedItem("title") as HTMLInputElement).focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "f") {
    event.preventDefault();
    document.querySelector("#search")!.focus();
  }
});

function render(records: readonly LifeRecord[]): void {
  const summary = summarize(records);
  document.querySelector("#summary")!.innerHTML = [
    ["Open", summary.total - summary.completed],
    ["Due soon", summary.dueSoon],
    ["Overdue", summary.overdue],
    [theme.effortLabel, summary.effort],
    ...theme.categories.map(cat => [`${cat}`, summary.byCategory[cat] || 0])
  ].map(([label, value]) => {
    const color = theme.categoryColors[label] || 'inherit';
    return `<article style="border-left: 4px solid ${color}"><span>${label}</span><strong style="color: ${color === 'inherit' ? 'inherit' : color}">${value}</strong></article>`;
  }).join("");
  
  const allRecords = [...records].sort((a, b) => {
    const aEntry = priorityFor(a);
    const bEntry = priorityFor(b);
    return bEntry.score - aEntry.score || a.dueDate.localeCompare(b.dueDate);
  });

  const filtered = allRecords.filter((item) => {
    if (item.status === 'archived' && !showArchived) return false;
    if (!showCompleted && item.status === "done") return false;
    if (activeOnly && item.status !== "active") return false;
    const matchesCategory = selectedCategory === "all" || item.category === selectedCategory;
    const matchesSearch = !searchQuery || 
      item.title.toLowerCase().includes(searchQuery) || 
      item.notes.toLowerCase().includes(searchQuery);
    return matchesCategory && matchesSearch;
  });

  const bulkDiv = document.querySelector("#bulk-actions")!;
  const doneCount = records.filter(r => r.status === "done").length;
  bulkDiv.innerHTML = '';
  if (doneCount > 0) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = `Archive ${doneCount} completed`;
    btn.onclick = () => {
      const now = new Date().toISOString();
      records.filter(r => r.status === 'done').forEach(r => {
        store.upsert({ ...r, status: 'archived', updatedAt: now });
      });
    };
    bulkDiv.appendChild(btn);
  }
  if (selectedCategory !== 'all') {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = `Mark ${selectedCategory} as done`;
    btn.onclick = () => {
      const now = new Date().toISOString();
      records.filter(r => r.category === selectedCategory && r.status !== 'done').forEach(r => {
        store.upsert({ ...r, status: 'done', updatedAt: now });
      });
    };
    bulkDiv.appendChild(btn);
    
    const remBtn = document.createElement('button');
    remBtn.className = 'ghost danger';
    remBtn.textContent = `Remove ${selectedCategory}`;
    remBtn.onclick = () => {
      const toRemove = records.filter(r => r.category === selectedCategory);
      if (toRemove.length > 0 && confirm(`Permanently remove all ${toRemove.length} records in ${selectedCategory}?`)) {
        toRemove.forEach(r => store.remove(r.id));
      }
    };
    bulkDiv.appendChild(remBtn);
  }

  document.querySelector("#plan")!.innerHTML = filtered.length ? filtered.map((item) => {
    const entry = priorityFor(item);
    const isDone = item.status === "done";
    const isArchived = item.status === "archived";
    const isActive = item.status === "active";
    const isOverdue = entry.daysUntilDue < 0 && !isDone && !isArchived;
    const scoreClass = entry.score > 100 ? "score-high" : entry.score > 60 ? "score-med" : "score-low";
    const catColor = theme.categoryColors[item.category] || '#176b55';
    const lastMod = new Date(item.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<article class="record ${isDone ? "done" : ""} ${isArchived ? "archived" : ""} ${isActive ? "active" : ""} ${isOverdue ? "overdue" : ""}">
      <div class="record-main">
        <span class="badge" style="background: ${catColor}20; color: ${catColor}">
          <select class="edit-category" data-id="${escapeHtl(item.id)}" style="color: inherit">
            ${theme.categories.map(cat => `<option ${cat === item.category ? 'selected' : ''}>${cat}</option>`).join('')}
          </select>
        </span>
        <input class="edit-title" data-id="${escapeHtl(item.id)}" value="${escapeHtml(item.title)}" maxlength="100" style="${(isDone || isArchived) ? "text-decoration: line-through; opacity: 0.6" : ""}">
        <p>${escapeHtml(entry.reasons.join("; "))}</p>
        <div class="record-edit-grid">
          <label>${theme.dateLabel}<input type="date" class="edit-date" data-id="${escapeHtl(item.id)}" value="${item.dueDate}"></label>
          <label>${theme.effortLabel}
            <div class="adjust-wrap">
              <button class="adjust-btn" data-id="${escapeHtl(item.id)}" data-field="effort" data-delta="-15">-</button>
              <input type="number" class="edit-effort" data-id="${escapeHtl(item.id)}" value="${item.effort}" min="1" max="480">
              <button class="adjust-btn" data-id="${escapeHtl(item.id)}" data-field="effort" data-delta="15">+</button>
            </div>
          </label>
          <label>${theme.impactLabel}
            <div class="adjust-wrap">
              <button class="adjust-btn" data-id="${escapeHtl(item.id)}" data-field="impact" data-delta="-1">-</button>
              <input type="number" class="edit-impact" data-id="${escapeHtl(item.id)}" value="${item.impact}" min="1" max="5">
              <button class="adjust-btn" data-id="${escapeHtl(item.id)}" data-field="impact" data-delta="1">+</button>
            </div>
          </label>
        </div>
        <div class="record-notes-container" data-id="${escapeHtl(item.id)}">
          <div class="notes-preview">${item.notes ? escapeHtml(item.notes) : '<span class="placeholder">No notes...</span>'}</div>
          <textarea class="record-notes hidden" placeholder="Add notes...">${escapeHtml(item.notes)}</textarea>
          <button class="ghost notes-toggle">Edit Notes</button>
        </div>
        <div class="record-footer"><small>Modified: ${lastMod}</small></div>
      </div>
      <div class="record-actions">
        <div class="score-wrap"><strong class="${scoreClass}" style="${(isDone || isArchived) ? "opacity: 0.5" : ""}">${entry.score}</strong></div>
        <select data-status="${escapeHtml(item.id)}">
          ${(["planned", "active", "done", "archived"] as ItemStatus[]).map((status) => `<option ${status === item.status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <div class="record-btn-group">
          ${!isDone && !isArchived ? `<button class="ghost" data-mark-done="${escapeHtl(item.id)}" aria-label="Mark ${escapeHtml(item.title)} as done">Done</button>` : ""}
          <button class="ghost" data-today="${escapeHtl(item.id)}" aria-label="Move ${escapeHtml(item.title)} to today">Today</button>
          <button class="ghost" data-tomorrow="${escapeHtl(item.id)}" aria-label="Move ${escapeHtml(item.title)} to tomorrow">Tomorrow</button>
          <button class="ghost" data-next-week="${escapeHtl(item.id)}" aria-label="Move ${escapeHtml(item.title)} to next week">Next Week</button>
          <button class="ghost" data-duplicate="${escapeHtl(item.id)}" aria-label="Duplicate ${escapeHtml(item.title)}">Duplicate</button>
          <button class="danger ghost" data-remove="${escapeHtl(item.id)}" aria-label="Remove ${escapeHtml(item.title)}">Remove</button>
        </div>
      </div></article>`;
  }).join("") : "<p class='empty'>No open records match this view.</p>";
  
  for (const container of document.querySelectorAll<HTMLDivElement>(".record-notes-container")) {
    const id = container.dataset.id!;
    const textarea = container.querySelector<HTMLTextAreaElement>(".record-notes")!;
    const preview = container.querySelector<HTMLDivElement>(".notes-preview")!;
    const toggle = container.querySelector<HTMLButtonElement>(".notes-toggle")!;

    toggle.onclick = () => {
      const isHidden = textarea.classList.contains("hidden");
      textarea.classList.toggle("hidden");
      preview.classList.toggle("hidden");
      toggle.textContent = isHidden ? "Save Notes" : "Edit Notes";
      if (isHidden) textarea.focus();
    };

    textarea.onblur = () => {
      const item = records.find((x) => x.id === id);
      if (item && item.notes !== textarea.value) {
        showUndo({ ...item }, 'edited');
        store.upsert({ ...item, notes: textarea.value, updatedAt: new Date().toISOString() });
      }
    };

    textarea.oninput = () => {
      preview.textContent = textarea.value || "No notes...";
    };
  }

  for (const input of document.querySelectorAll<HTMLInputElement>(".edit-effort, .edit-impact, .edit-title, .edit-date")) {
    input.onchange = () => {
      const id = input.dataset.id!;
      const item = records.find((x) => x.id === id);
      if (!item) return;
      const val = input.value;
      
      if (input.classList.contains("edit-title")) {
        const trimmed = val.trim();
        if (trimmed.length > 0 && item.title !== trimmed) {
          showUndo({ ...item }, 'edited');
          store.upsert({ ...item, title: trimmed, updatedAt: new Date().toISOString() });
        }
        else if (trimmed.length === 0) input.value = item.title;
      } else if (input.classList.contains("edit-effort")) {
        const num = parseInt(val, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= 480) {
          showUndo({ ...item }, 'edited');
          store.upsert({ ...item, effort: num, updatedAt: new Date().toISOString() });
        }
        else input.value = item.effort.toString();
      } else if (input.classList.contains("edit-impact")) {
        const num = parseInt(val, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= 5) {
          showUndo({ ...item }, 'edited');
          store.upsert({ ...item, impact: num, updatedAt: new Date().toISOString() });
        }
        else input.value = item.impact.toString();
      } else if (input.classList.contains("edit-date")) {
        if (val && item.dueDate !== val) {
          showUndo({ ...item }, 'edited');
          store.upsert({ ...item, dueDate: val, updatedAt: new Date().toISOString() });
        }
        else if (!val) input.value = item.dueDate;
      }
    };
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>(".adjust-btn")) {
    btn.onclick = () => {
      const id = btn.dataset.id!;
      const field = btn.dataset.field! as 'effort' | 'impact';
      const delta = parseInt(btn.dataset.delta!, 10);
      const item = records.find(r => r.id === id);
      if (!item) return;

      const currentVal = item[field];
      let newVal = currentVal + delta;
      
      if (field === 'effort') newVal = Math.max(1, Math.min(480, newVal));
      else newVal = Math.max(1, Math.min(5, newVal));

      if (newVal !== currentVal) {
        showUndo({ ...item }, 'edited');
        store.upsert({ ...item, [field]: newVal, updatedAt: new Date().toISOString() });
      }
    };
  }

  for (const select of document.querySelectorAll<HTMLSelectElement>(".edit-category")) {
    select.onchange = () => {
      const id = select.dataset.id!;
      const item = records.find((x) => x.id === id);
      if (item && item.category !== select.value) {
        showUndo({ ...item }, 'edited');
        store.upsert({ ...item, category: select.value, updatedAt: new Date().toISOString() });
      }
    };
  }

  for (const select of document.querySelectorAll<HTMLSelectElement>("[data-status]")) select.onchange = () => {
    const item = records.find((x) => x.id === select.dataset.status);
    if (!item) return;
    showUndo({ ...item }, 'edited');
    store.upsert({ ...item, status: select.value as ItemStatus, updatedAt: new Date().toISOString() });
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-remove]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.remove!);
    if (record && confirm(`Remove "${escapeHtml(record.title)}"?`)) {
      showUndo(record, 'deleted');
      store.remove(record.id);
    }
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-duplicate]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.duplicate!);
    if (record) {
      const now = new Date().toISOString();
      store.upsert({
        ...record,
        id: crypto.randomUUID(),
        title: `${record.title} (Copy)`,
        createdAt: now,
        updatedAt: now
      });
    }
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tomorrow]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.tomorrow!);
    if (record) {
      const tomorrow = new Date(Date.parse(`${record.dueDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      showUndo({ ...record }, 'edited');
      store.upsert({ ...record, dueDate: tomorrow, updatedAt: new Date().toISOString() });
    }
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-today]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.today!);
    if (record) {
      showUndo({ ...record }, 'edited');
      store.upsert({ ...record, dueDate: localDay(), updatedAt: new Date().toISOString() });
    }
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-next-week]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.nextWeek!);
    if (record) {
      const nextWeek = new Date(Date.parse(`${record.dueDate}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      showUndo({ ...record }, 'edited');
      store.upsert({ ...record, dueDate: nextWeek, updatedAt: new Date().toISOString() });
    }
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mark-done]")) button.onclick = () => {
    const record = records.find(r => r.id === button.dataset.markDone!);
    if (record) {
      showUndo({ ...record }, 'edited');
      store.upsert({ ...record, status: 'done', updatedAt: new Date().toISOString() });
    }
  };
  document.querySelector("#week")!.innerHTML = suggestDailyLoad(records, Number(capacity.value) || 90).map((day) => `<article class="day ${day.overloaded ? "over" : ""}">
    <span>${new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span><strong>${day.used} min</strong>
    <small>${day.entries.length} item(s)</small></article>`).join("");
}

// Helper for dataset values since escapeHtml was designed for content
function escapeHtl(value: string) { return value.replace(/[\"']/g, ""); }

store.subscribe(render);
