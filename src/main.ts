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
  <main class="layout"><section class="panel"><div class="panel-title"><h2>Add ${theme.itemLabel.toLowerCase()}</h2>
    <button id="seed-export" class="ghost">Export JSON</button></div><form id="record-form" novalidate>
    <label>Title<input name="title" maxlength="100" required></label>
    <div class="form-grid"><label>Category<select name="category">${theme.categories.map((x) => `<option>${x}</option>`).join("")}</select></label>
    <label>${theme.dateLabel}<input name="dueDate" type="date" value="${localDay()}" required></label>
    <label>${theme.effortLabel}<input name="effort" type="number" min="1" max="480" value="30" required></label>
    <label>${theme.impactLabel}<input name="impact" type="number" min="1" max="5" value="3" required></label></div>
    <label>Notes<textarea name="notes" rows="3" maxlength="600"></textarea></label><p id="errors" class="errors"></p>
    <button type="submit">Add to plan</button></form><div class="exchange"><button id="csv" class="ghost">Export CSV</button>
    <label class="file">Import JSON<input id="import" type="file" accept="application/json"></label></div></section>
  <section class="panel plan-panel"><div class="panel-title"><h2>Priority plan</h2><select id="filter"><option value="all">All categories</option>
    ${theme.categories.map((x) => `<option>${x}</option>`).join("")}</select></div><div id="plan"></div></section></main>
  <section class="panel week-panel"><div class="panel-title"><h2>Seven-day load</h2><label>Daily capacity
    <input id="capacity" type="number" min="15" max="480" step="15" value="90"></label></div><div id="week" class="week"></div></section>
`;

const form = document.querySelector<HTMLFormElement>("#record-form")!;
const errors = document.querySelector<HTMLParagraphElement>("#errors")!;
const capacity = document.querySelector<HTMLInputElement>("#capacity")!;

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
});

document.querySelector<HTMLSelectElement>("#filter")!.addEventListener("change", (event) => {
  selectedCategory = (event.target as HTMLSelectElement).value; render(store.all());
});
capacity.addEventListener("input", () => render(store.all()));
document.querySelector("#seed-export")!.addEventListener("click", () => download("records.json", exportJson(store.all()), "application/json"));
document.querySelector("#csv")!.addEventListener("click", () => download("records.csv", exportCsv(store.all()), "text/csv"));
document.querySelector<HTMLInputElement>("#import")!.addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try { store.replace(importJson(await file.text(), theme)); errors.textContent = ""; }
  catch (error) { errors.textContent = error instanceof Error ? error.message : "Import failed."; }
});

function render(records: readonly LifeRecord[]): void {
  const summary = summarize(records);
  document.querySelector("#summary")!.innerHTML = [
    ["Open", summary.total - summary.completed], ["Due soon", summary.dueSoon],
    ["Overdue", summary.overdue], [theme.effortLabel, summary.effort],
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  const plan = buildPlan(records).filter((entry) => selectedCategory === "all" || entry.item.category === selectedCategory);
  document.querySelector("#plan")!.innerHTML = plan.length ? plan.map((entry) => `<article class="record">
    <div><span class="badge">${escapeHtml(entry.item.category)}</span><h3>${escapeHtml(entry.item.title)}</h3><p>${escapeHtml(entry.reasons.join("; "))}</p></div>
    <div class="record-actions"><strong>${entry.score}</strong><select data-status="${escapeHtml(entry.item.id)}">
    ${(["planned", "active", "done"] as ItemStatus[]).map((status) => `<option ${status === entry.item.status ? "selected" : ""}>${status}</option>`).join("")}</select>
    <button class="danger ghost" data-remove="${escapeHtml(entry.item.id)}">Remove</button></div></article>`).join("") : "<p class='empty'>No open records match this view.</p>";
  for (const select of document.querySelectorAll<HTMLSelectElement>("[data-status]")) select.onchange = () => {
    const item = records.find((x) => x.id === select.dataset.status); if (!item) return;
    store.upsert({ ...item, status: select.value as ItemStatus, updatedAt: new Date().toISOString() });
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-remove]")) button.onclick = () => store.remove(button.dataset.remove!);
  document.querySelector("#week")!.innerHTML = suggestDailyLoad(records, Number(capacity.value) || 90).map((day) => `<article class="day ${day.overloaded ? "over" : ""}">
    <span>${new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span><strong>${day.used} min</strong>
    <small>${day.entries.length} item(s)</small></article>`).join("");
}

store.subscribe(render);
