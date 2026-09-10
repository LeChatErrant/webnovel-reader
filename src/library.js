// =========================================================================
// LIBRARY (home) — the root screen: the Continue card, the cover shelf of books
// and series, and the multi-select-into-a-series mode. Tapping a book cover
// opens its info page; tapping a series tile opens the series info page.
// =========================================================================
import { el, h, svg, coverNode, progressBar, attachLongPress } from "./dom.js";
import { books, series, progressMap, ui, bookById, saveUi, deleteBook } from "./state.js";
import { normalize, toRoman, stripVolume, longestCommonName } from "./lib/text.js";
import { chapterCount } from "./lib/chapters.js";
import { formatAdded } from "./lib/format.js";
import {
  displayTitle, seriesVolumes, seriesPercent, currentVolume, bookPercent,
  continueSubtitle, continueTarget,
} from "./reading.js";
import { openBook } from "./reader.js";
import { openInfo } from "./router.js";
import { openInfoMenu, infoModel } from "./info.js";
import { pickFiles, openDevSeedMenu, groupIntoSeries } from "./import.js";
import { showNameSheet, showConfirmSheet } from "./sheets.js";

let libFilter = "";
export const setLibFilter = (v) => { libFilter = v; };

// One entry per shelf tile: a standalone book or a whole series.
function shelfItems() {
  const items = [
    ...series.map((s) => ({ type: "series", series: s, title: s.name, activity: seriesActivity(s) })),
    ...books.filter((b) => !b.seriesId).map((b) => ({ type: "book", book: b, title: displayTitle(b), activity: bookActivity(b) })),
  ];
  if (ui.sort === "title") items.sort((a, b) => a.title.localeCompare(b.title));
  else items.sort((a, b) => b.activity - a.activity);
  if (libFilter) {
    const q = libFilter.toLowerCase();
    return items.filter((it) => it.title.toLowerCase().includes(q));
  }
  return items;
}
const bookActivity = (b) => progressMap[b.id]?.updatedAt || b.addedAt || 0;
const seriesActivity = (s) => Math.max(0, ...seriesVolumes(s).map(bookActivity));

export function renderLibrary() {
  const body = el.libBody;
  body.innerHTML = "";

  if (!books.length) {
    body.append(emptyState());
    return;
  }

  // Continue section.
  const cont = continueTarget();
  if (cont && !libFilter) body.append(continueSection(cont));

  // All books.
  const items = shelfItems();
  const section = h("section", { class: "lib-section lib-section--grid" });
  const head = h(
    "div",
    { class: "lib-section__head" },
    h("span", { class: "lib-label" }, `All books · ${items.length}`),
    h(
      "button",
      { class: "sort-btn", onclick: toggleSort },
      ui.sort === "title" ? "Title" : "Recent",
      svg('<svg viewBox="0 0 24 24" width="13" height="13" style="margin-left:2px"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')
    )
  );
  section.append(head);

  // Title-collision cue (11c): when two or more shelf entries share a title,
  // each colliding tile is disambiguated with a numeral and a meta prefix. This
  // is derived from the current shelf, never stored on the book.
  const titleCounts = new Map();
  for (const it of items) {
    const k = normalize(it.title);
    titleCounts.set(k, (titleCounts.get(k) || 0) + 1);
  }
  const collides = (title) => (titleCounts.get(normalize(title)) || 0) > 1;
  // Under Recent sort, hold colliding entries adjacent so duplicates read as a
  // run rather than scattered look-alikes. Title sort already groups them.
  let ordered = items;
  if (ui.sort !== "title") {
    const out = [];
    const done = new Set();
    for (const it of items) {
      const k = normalize(it.title);
      if (done.has(k)) continue;
      done.add(k);
      out.push(it);
      if ((titleCounts.get(k) || 0) > 1) {
        for (const other of items) if (other !== it && normalize(other.title) === k) out.push(other);
      }
    }
    ordered = out;
  }

  const grid = h("div", { class: "grid" });
  for (const it of ordered) grid.append(it.type === "series" ? seriesTile(it.series) : bookTile(it.book, collides(it.title)));
  grid.append(importTile());
  section.append(grid);
  body.append(section);
}

function continueSection(book) {
  const card = h(
    "button",
    { class: "continue-card", onclick: () => openBook(book.id) },
    coverNode(book, "continue-card__cover"),
    h(
      "div",
      { class: "continue-card__text" },
      h("div", { class: "continue-card__title" }, displayTitle(book)),
      h("div", { class: "continue-card__sub" }, continueSubtitle(book)),
      progressBar(bookPercent(book), "card")
    )
  );
  return h(
    "section",
    { class: "lib-section lib-section--continue" },
    h("div", { class: "lib-label" }, "Continue"),
    card
  );
}

function bookTile(book, collides = false) {
  const selecting = !!selection;
  const selected = selecting && selection.has(book.id);
  const cover = coverNode(book, "tile__cover");
  cover.append(progressBar(bookPercent(book), "cover"));
  // Collision cue: an OUTLINED roman-numeral pill, deliberately distinct from
  // the filled series volume-count badge, so the two are never confused.
  const numeral = collides && book.volumeIndex ? toRoman(book.volumeIndex) : null;
  if (numeral) cover.append(h("span", { class: "vol-pill" }, numeral));
  if (selected) cover.append(h("span", { class: "tile__check" }, "✓"));
  // Meta line (11c): how much is in the thing, never where you are. A colliding
  // look-alike also gets a disambiguating prefix — its volume number, or the
  // added date when the number can't be resolved.
  const n = chapterCount(book);
  const chText = `${n.toLocaleString()} chapter${n === 1 ? "" : "s"}`;
  let meta;
  if (collides) {
    const prefix = book.volumeIndex
      ? `Vol. ${book.volumeIndex} · `
      : formatAdded(book.addedAt)
        ? `Added ${formatAdded(book.addedAt)} · `
        : "";
    meta = h("div", { class: "tile__meta" }, prefix ? h("span", { class: "tile__meta-vol" }, prefix) : null, chText);
  } else {
    meta = h("div", { class: "tile__meta" }, chText);
  }
  const tile = h(
    "div",
    { class: "tile" + (selecting ? " tile--selectable" : "") + (selected ? " tile--selected" : ""), dataset: { bookId: book.id } },
    cover,
    h("div", { class: "tile__title" }, displayTitle(book)),
    meta
  );
  attachTileGestures(tile, book);
  return tile;
}

function seriesTile(s) {
  const cur = currentVolume(s);
  const cover = coverNode(cur, "tile__cover");
  cover.append(h("span", { class: "vol-badge" }, String(s.bookIds.length)));
  cover.append(progressBar(seriesPercent(s), "cover"));
  const stack = h("div", { class: "series-stack" }, h("i", { class: "series-stack__l3" }), h("i", { class: "series-stack__l2" }), cover);
  const n = s.bookIds.length;
  const tile = h(
    "div",
    { class: "tile tile--series" },
    stack,
    h("div", { class: "tile__title" }, s.name),
    // Meta line (11c): "N volumes" — how much is in the series, never position.
    h("div", { class: "tile__meta" }, `${n} volume${n === 1 ? "" : "s"}`)
  );
  // Tap opens the series page; long-press raises its actions (edit, series
  // details, delete) without a detour through that page.
  attachLongPress(tile, {
    canStart: () => !selection,
    onLongPress: () => openInfoMenu(infoModel("series", s.id)),
    onTap: () => { if (!selection) openInfo("series", s.id); },
  });
  return tile;
}

function importTile() {
  const tile = h(
    "button",
    { class: "tile tile--import" },
    h(
      "div",
      { class: "import-box" },
      h("span", { class: "import-box__plus" }, "+"),
      h("span", { class: "import-box__label" }, "Import")
    ),
    h("div", { class: "tile__meta" }, ".epub from your files")
  );
  // Tap imports; a long-press is the hidden dev-seed reset.
  attachSeedGesture(tile, pickFiles);
  return tile;
}

// Tap runs `onTap`; a long-press opens the hidden dev menu (seed / clear the
// demo library). Shared by the Import tile and the empty-state Import button so
// it's reachable even with an empty library.
function attachSeedGesture(node, onTap) {
  attachLongPress(node, { canStart: () => !selection, onLongPress: openDevSeedMenu, onTap });
}

function emptyState() {
  const cta = h("button", { class: "empty__cta" }, "+ Import an .epub");
  // Tap imports; long-press seeds the demo library (dev-only).
  attachSeedGesture(cta, pickFiles);
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty__book" }),
    h("div", { class: "empty__title" }, "No books yet"),
    h(
      "p",
      { class: "empty__lead" },
      "Add an .epub from your files and it stays on this device — covers, chapters and your place in it."
    ),
    cta
  );
}

function toggleSort() {
  ui.sort = ui.sort === "title" ? "recent" : "title";
  saveUi();
  renderLibrary();
}

// =========================================================================
// Selection mode — long-press a cover to group covers into a series.
// =========================================================================
let selection = null; // Set of book ids, or null when not selecting
export const isSelecting = () => selection !== null;

function attachTileGestures(tile, book) {
  attachLongPress(tile, {
    canStart: () => !selection, // don't arm a new press while already selecting
    onLongPress: () => enterSelection(book.id),
    onTap: () => (selection ? toggleSelect(book.id) : openInfo("book", book.id)),
  });
}

function enterSelection(id) {
  selection = new Set([id]);
  document.getElementById("app").classList.add("selecting");
  updateSelectBar();
  renderLibrary();
}
function toggleSelect(id) {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  if (selection.size === 0) return exitSelection();
  updateSelectBar();
  renderLibrary();
}
export function exitSelection() {
  selection = null;
  document.getElementById("app").classList.remove("selecting");
  el.selectBar.hidden = true;
  renderLibrary();
}
function updateSelectBar() {
  el.selectBar.hidden = false;
  el.selectCount.textContent = `${selection.size} selected`;
  el.selectGroup.disabled = selection.size < 2;
}
export async function confirmGrouping() {
  const ids = [...selection];
  if (ids.length < 2) return;
  const titles = ids.map((id) => bookById(id)?.title || "");
  const prefill = longestCommonName(titles) || stripVolume(titles[0]);
  const name = await showNameSheet("Name this series", prefill, "Create series");
  if (name) {
    await groupIntoSeries(ids, name);
    exitSelection();
  }
}

export async function confirmDeleteSelection() {
  const ids = [...selection];
  if (!ids.length) return;
  const many = ids.length > 1;
  const ok = await showConfirmSheet(
    many ? `Delete ${ids.length} books?` : "Delete this book?",
    (many ? "They will be" : "It will be") + " removed from this device — the file and your place in it. This can't be undone.",
    "Delete"
  );
  if (!ok) return;
  for (const id of ids) await deleteBook(id);
  exitSelection(); // re-renders the library
}
