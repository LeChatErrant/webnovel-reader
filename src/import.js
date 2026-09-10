// =========================================================================
// Getting books into the library — .epub parsing, the import flow (with
// duplicate/series grouping), the file picker, and the hidden dev-seed menu.
// Nothing here renders; callers re-render through renderCurrentRoute.
// =========================================================================
import ePub from "epubjs";
import { parseVolumeIndex, stripVolume, seriesKey } from "./lib/text.js";
import { flatten, chapterCount, readableChapters } from "./lib/chapters.js";
import {
  books, series, bookById, seriesById, uid, progressMap, ui, saveUi,
  putProgress, migrateProgressRecords, setBooks, setSeries,
} from "./state.js";
import { dbPut, dbDelete } from "./db.js";
import { el, coverUrls } from "./dom.js";
import { seriesVolumes } from "./reading.js";
import { showSuggestSheet, showActionSheet, showConfirmSheet } from "./sheets.js";
import { renderCurrentRoute } from "./router.js";

// -------------------------------------------------------------------------
// Epub parsing on import — title, author, cover blob, chapter list.
// -------------------------------------------------------------------------
// dc:subject isn't exposed by epub.js's parsed metadata, so read it straight
// from the package document. Best-effort: any failure just yields no subjects.
async function parseSubjects(b) {
  try {
    const opfPath = b.container?.packagePath || b.packaging?.metadata?.packagePath;
    if (!opfPath || !b.archive) return [];
    const xml = await b.archive.getText(opfPath);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return [...doc.getElementsByTagNameNS("*", "subject")]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function parseEpub(buffer, filename) {
  const b = ePub(buffer);
  await b.ready;
  const meta = await b.loaded.metadata.catch(() => ({}));
  const nav = await b.loaded.navigation.catch(() => ({ toc: [] }));
  const chapters = flatten(nav.toc);
  const spineCount = b.spine?.spineItems?.length || chapters.length || 1;
  const subjects = await parseSubjects(b);
  let coverBlob = null;
  try {
    const url = await b.coverUrl();
    if (url) coverBlob = await (await fetch(url)).blob();
  } catch {
    /* no cover */
  }
  const title = (meta.title || filename.replace(/\.epub$/i, "")).trim();
  const author = (meta.creator || "").trim();
  const clean = (v) => (v || "").trim();
  try {
    b.destroy();
  } catch {
    /* ignore */
  }
  return {
    title,
    author,
    coverBlob,
    chapters,
    spineCount,
    // Extra descriptive metadata for the info page. Web-novel epubs are often
    // sloppy, so any of these may be empty — the info page omits blank fields.
    description: clean(meta.description),
    language: clean(meta.language),
    publisher: clean(meta.publisher),
    published: clean(meta.pubdate),
    subjects,
    volumeIndex: parseVolumeIndex(title) || parseVolumeIndex(filename),
  };
}

export async function createBook(buffer, filename, { seriesId = null } = {}) {
  const parsed = await parseEpub(buffer, filename);
  const book = {
    id: uid(),
    ...parsed,
    fileName: filename,
    fileBlob: new Blob([buffer], { type: "application/epub+zip" }),
    seriesId,
    addedAt: Date.now(),
  };
  books.push(book);
  await dbPut("books", book);
  return book;
}

// -------------------------------------------------------------------------
// Import flow — pick .epub files, parse and store them, then look for
// obvious duplicates/series to suggest grouping (never grouping silently).
// -------------------------------------------------------------------------
let pendingImportSeriesId = null;

export async function importFiles(fileList) {
  const intoSeriesId = pendingImportSeriesId;
  pendingImportSeriesId = null;
  const files = [...fileList].filter((f) => /\.epub$/i.test(f.name));
  if (!files.length) return;

  const added = [];
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const book = await createBook(buffer, file.name, { seriesId: intoSeriesId });
      added.push(book);
    } catch (err) {
      console.warn("Could not import", file.name, err);
      alert(`Couldn't read "${file.name}". It may not be a valid .epub file.`);
    }
  }
  if (!added.length) return;

  if (intoSeriesId) {
    const s = seriesById(intoSeriesId);
    if (s) {
      for (const b of added) {
        b.volumeIndex = b.volumeIndex || s.bookIds.length + 1;
        s.bookIds.push(b.id);
        await dbPut("books", b);
      }
      await dbPut("series", s);
    }
  }

  renderCurrentRoute();
  if (!intoSeriesId) await suggestGrouping(added);
}

// After import, cluster books by (title-without-volume + author). Any cluster
// of 2+ standalone books that includes a new import gets one suggestion card.
// The prompt is import-time only (it never nags in the background), so we ask
// whenever look-alikes are imported. "Keep separate" declines just this import
// rather than suppressing the title forever — a permanent, easily-triggered
// dismissal (e.g. an accidental tap outside the sheet) silently killed the
// feature on phones.
async function suggestGrouping(added) {
  const seen = new Set();
  for (const nb of added) {
    const key = seriesKey(nb);
    if (seen.has(key)) continue;
    seen.add(key);
    const cluster = books.filter((b) => seriesKey(b) === key);
    const seriesIds = new Set(cluster.map((b) => b.seriesId).filter(Boolean));
    if (seriesIds.size > 1) continue; // already split across series — leave it
    const grouped = cluster.every((b) => b.seriesId);
    if (grouped) continue; // already one series
    if (cluster.length < 2) continue;
    const name = stripVolume(nb.title) || nb.title;
    const grouping = await showSuggestSheet(name, cluster.length);
    if (grouping) await groupIntoSeries(cluster.map((b) => b.id), name);
    renderCurrentRoute();
  }
}

// Create a series from a set of books, or fold them into an existing one if
// any of them already belongs to a series. Volume order: explicit index, then
// import order.
export async function groupIntoSeries(bookIds, name) {
  const chosen = bookIds.map(bookById).filter(Boolean);
  if (chosen.length < 2) return;
  let s = chosen.map((b) => (b.seriesId ? seriesById(b.seriesId) : null)).find(Boolean);
  if (!s) {
    s = { id: uid(), name, author: chosen[0].author || "", bookIds: [] };
    series.push(s);
  }
  const existing = new Set(s.bookIds);
  const incoming = chosen.filter((b) => !existing.has(b.id));
  incoming.sort((a, b) => (a.volumeIndex ?? 99) - (b.volumeIndex ?? 99) || a.addedAt - b.addedAt);
  for (const b of incoming) s.bookIds.push(b.id);
  // Assign volume numbers by final order where missing.
  s.bookIds.forEach((id, i) => {
    const b = bookById(id);
    if (b) {
      b.seriesId = s.id;
      if (!b.volumeIndex) b.volumeIndex = i + 1;
    }
  });
  await dbPut("series", s);
  await Promise.all(seriesVolumes(s).map((b) => dbPut("books", b)));
}

// Import the next picked file(s) straight into this series (the info page's
// "Add a volume" button and the reader's volume-boundary card).
export function addVolumeToSeries(seriesId) {
  pendingImportSeriesId = seriesId;
  pickFiles();
}

// -------------------------------------------------------------------------
// File picking
// -------------------------------------------------------------------------
export function pickFiles() {
  el.fileInput.click();
}

// -------------------------------------------------------------------------
// Dev seeding — a hidden menu that fills the library with a fixed set of
// real, public-domain books covering every design case (with/without cover,
// started/unstarted, loose volumes, and shelves), or clears them again to get
// back to a blank environment. Triggered by a long-press on the Import tile (or
// the empty-state Import button). Both actions touch only content tagged
// `seeded: true`, leaving any real imported books untouched — so seeding never
// duplicates the demo set and clearing never destroys real content.
//
// The books live in public/seed/ with a manifest describing how to arrange
// them; see scripts/fetch-seed.mjs. They are excluded from the PWA precache, so
// they never ship to real users — only a deliberate long-press fetches them.
// -------------------------------------------------------------------------
let seeding = false;

// Raise the seed/clear chooser. "Clear" only appears when there is seeded
// content to remove, so the menu reads as empty-library "seed" vs seeded-library
// "seed or clear".
export function openDevSeedMenu() {
  if (seeding) return;
  const seededCount = books.filter((b) => b.seeded).length;
  const actions = [{ label: seededCount ? "Re-seed demo library" : "Seed demo library", onClick: confirmAndSeed }];
  if (seededCount) {
    actions.push({
      label: `Clear ${seededCount} seeded book${seededCount === 1 ? "" : "s"}`,
      danger: true,
      onClick: confirmAndClearSeeded,
    });
  }
  showActionSheet(actions);
}

async function confirmAndSeed() {
  if (seeding) return;
  const ok = await showConfirmSheet(
    "Seed demo library",
    "Reset the demo books to a fixed set? This only replaces previously seeded books — your real imported books are left untouched.",
    "Seed"
  );
  if (!ok) return;
  seeding = true;
  try {
    await seedDemoLibrary();
  } catch (err) {
    console.warn("Seeding failed", err);
    alert("Seeding failed: " + (err?.message || err));
  } finally {
    seeding = false;
  }
}

// Remove every seeded demo book/shelf, leaving real imported content in place.
async function confirmAndClearSeeded() {
  if (seeding) return;
  const seededCount = books.filter((b) => b.seeded).length;
  if (!seededCount) return;
  const ok = await showConfirmSheet(
    "Clear seeded books",
    `Remove the ${seededCount} demo book${seededCount === 1 ? "" : "s"} (and their shelves and progress)? Your real imported books are left untouched.`,
    "Clear"
  );
  if (!ok) return;
  seeding = true;
  try {
    await clearSeededContent();
    renderCurrentRoute();
  } catch (err) {
    console.warn("Clearing seeded content failed", err);
    alert("Clearing failed: " + (err?.message || err));
  } finally {
    seeding = false;
  }
}

// Remove only previously-seeded books, shelves and reading positions — in
// memory and on disk. Real imported content (anything without `seeded: true`)
// is left completely untouched.
async function clearSeededContent() {
  const seededBooks = books.filter((b) => b.seeded);
  const seededSeries = series.filter((s) => s.seeded);

  await Promise.all([
    ...seededBooks.map((b) => dbDelete("books", b.id)),
    ...seededBooks.map((b) => dbDelete("progress", b.id)),
    ...seededSeries.map((s) => dbDelete("series", s.id)),
  ]);

  for (const b of seededBooks) {
    if (coverUrls.has(b.id)) {
      URL.revokeObjectURL(coverUrls.get(b.id));
      coverUrls.delete(b.id);
    }
    delete progressMap[b.id];
    if (ui.lastReadBookId === b.id) ui.lastReadBookId = null;
  }

  const seededBookIds = new Set(seededBooks.map((b) => b.id));
  const seededSeriesIds = new Set(seededSeries.map((s) => s.id));
  setBooks(books.filter((b) => !seededBookIds.has(b.id)));
  setSeries(series.filter((s) => !seededSeriesIds.has(s.id)));
  await saveUi();
}

async function seedDemoLibrary() {
  const manifest = await (await fetch("./seed/manifest.json")).json();
  const entries = manifest.entries || [];

  await clearSeededContent();

  // 1. Import every epub (order preserved so the shelf reads intentionally).
  const rows = []; // { entry, book }
  for (const entry of entries) {
    const buffer = await (await fetch("./seed/" + entry.file)).arrayBuffer();
    const book = await createBook(buffer, entry.file);
    book.seeded = true;
    if (entry.noCover) book.coverBlob = null;
    await dbPut("books", book);
    rows.push({ entry, book });
  }

  const now = Date.now();
  const HOUR = 3600 * 1000;

  // 2. Group volumes into shelves, in manifest order, by series name.
  const bySeries = new Map();
  for (const { entry, book } of rows) {
    if (!entry.series) continue;
    if (!bySeries.has(entry.series)) bySeries.set(entry.series, []);
    bySeries.get(entry.series).push({ entry, book });
  }
  for (const [name, members] of bySeries) {
    const s = { id: uid(), name, author: members[0].book.author || "", bookIds: [], seeded: true };
    members.forEach(({ entry, book }, i) => {
      book.seriesId = s.id;
      book.volumeIndex = entry.vol || i + 1;
      s.bookIds.push(book.id);
    });
    await Promise.all(members.map(({ book }) => dbPut("books", book)));
    series.push(s);
    await dbPut("series", s);
  }

  // 3. Stagger "added" dates so the shelf isn't one indistinct block, then set
  // reading progress on the books the manifest marks as started.
  for (let i = 0; i < rows.length; i++) {
    rows[i].book.addedAt = now - (i + 1) * 6 * HOUR;
    await dbPut("books", rows[i].book);
  }
  for (const { entry, book } of rows) {
    if (!entry.started) continue;
    // The percentage bar is measured against the spine, so the stored index is
    // spine-based; the resume *label* is picked from the readable chapter list
    // at the same fraction, so it lands on a real chapter (not a title page).
    const total = book.spineCount || chapterCount(book);
    const idx = Math.max(0, Math.min(total - 1, Math.round(entry.started * total) - 1));
    const readable = readableChapters(book.chapters || []);
    const rIdx = Math.max(0, Math.min(readable.length - 1, Math.round(entry.started * readable.length) - 1));
    const label = readable[rIdx]?.label || "";
    // recency 0 = freshest (drives the "Continue" card); default well back.
    const updatedAt = now - (entry.recency != null ? entry.recency : 12) * HOUR;
    await putProgress({
      bookId: book.id,
      cfi: null,
      chapterIndex: idx,
      maxChapterIndex: idx,
      chapterLabel: label,
      finished: false,
      updatedAt,
    });
  }

  // Seeded records are written in the legacy shape; upgrade them to the
  // per-chapter map now so progress shows without waiting for a reload.
  await migrateProgressRecords();
  renderCurrentRoute();
}
