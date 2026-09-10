// =========================================================================
// INFO page (design 6a) — one screen for both a standalone book and a series;
// reached by tapping any cover on the shelf. A series gets the full page (with a
// Volumes block), a standalone book the same page without it. This module also
// holds the two full-screen editors (Edit details, Series details) and the
// volume sheet raised by long-pressing a volume row.
// =========================================================================
import { el, h, svg, ICON, coverNode, coverUrlFor, progressBar, attachLongPress, attachOrderDrag } from "./dom.js";
import { progressMap, bookById, seriesById, deleteBook } from "./state.js";
import { dbPut } from "./db.js";
import { stripVolume } from "./lib/text.js";
import { chapterCount, chapterOrdinalFor } from "./lib/chapters.js";
import { formatBytes, formatPublished, formatAdded, formatLang, stripHtml } from "./lib/format.js";
import {
  overrideOf, displayTitle, bookPercent, bookIsStarted, seriesVolumes, currentVolume,
  volumeNumber, volumeChapterOffset,
} from "./reading.js";
import { openBook } from "./reader.js";
import { go, currentInfo, selectedVolumeId, setSelectedVolumeId, armOverlay, closeOverlay } from "./router.js";
import { showActionSheet, showConfirmSheet } from "./sheets.js";
import { chaptersModel, chapterPreview, previewItemsFor, openChapters } from "./chapters.js";
import { addVolumeToSeries } from "./import.js";

// The text fields the info page shows and Edit details can type over.
const META_FIELDS = ["author", "description", "language", "published", "publisher"];

// Metadata for a collection resolves in priority order (spec 2d): a typed
// override wins, then the marked source volume, then the first volume with a
// value. Never merged field-by-field. Totals are summed across the collection.
function resolveField(container, vols, field, source) {
  const typed = overrideOf(container, field);
  if (typed) return typed;
  if (source && source[field]) return source[field];
  for (const b of vols) if (b[field]) return b[field];
  return "";
}
function resolveSubjects(container, vols, source) {
  if (container?.overrides?.subjects?.length) return container.overrides.subjects;
  if (source?.subjects?.length) return source.subjects;
  for (const b of vols) if (b.subjects?.length) return b.subjects;
  return [];
}
function metadataSource(s, vols) {
  return (s.metadataSourceBookId && bookById(s.metadataSourceBookId)) || vols[0] || null;
}

export function infoModel(kind, id) {
  if (kind === "series") {
    const s = seriesById(id);
    if (!s) return null;
    const vols = seriesVolumes(s);
    const source = metadataSource(s, vols);
    return {
      kind, id, series: s, volumes: vols, currentVolume: currentVolume(s),
      coverBook: source || currentVolume(s),
      title: s.name,
      author: resolveField(s, vols, "author", source),
      description: resolveField(s, vols, "description", source),
      subjects: resolveSubjects(s, vols, source),
      language: resolveField(s, vols, "language", source),
      publisher: resolveField(s, vols, "publisher", source),
      published: resolveField(s, vols, "published", source),
      volumeCount: vols.length,
      chapterCount: vols.reduce((n, b) => n + chapterCount(b), 0),
      fileCount: vols.length,
      byteSize: vols.reduce((n, b) => n + (b.fileBlob?.size || 0), 0),
      continueTarget: currentVolume(s),
    };
  }
  const b = bookById(id);
  if (!b) return null;
  return {
    kind, id, book: b, volumes: [], currentVolume: null,
    coverBook: b,
    title: overrideOf(b, "title") || b.title,
    author: overrideOf(b, "author") || b.author || "",
    description: overrideOf(b, "description") || b.description || "",
    subjects: b.overrides?.subjects?.length ? b.overrides.subjects : b.subjects || [],
    language: overrideOf(b, "language") || b.language || "",
    publisher: overrideOf(b, "publisher") || b.publisher || "",
    published: overrideOf(b, "published") || b.published || "",
    volumeCount: null,
    chapterCount: chapterCount(b),
    fileCount: 1,
    byteSize: b.fileBlob?.size || 0,
    continueTarget: b,
  };
}

// The primary-action label: it always names the volume/chapter, so the volume
// list is optional. Start reading · Continue ch. N · Continue vol. N · ch. M · Read again.
function continueInfo(m) {
  const t = m.continueTarget;
  if (!t) return { label: "Start reading", target: null };
  const p = progressMap[t.id];
  if (bookPercent(t) >= 100) return { label: "Read again", target: t };
  if (!p) return { label: "Start reading", target: t };
  if (m.kind === "series") {
    const abs = chapterOrdinalFor(t, p) + volumeChapterOffset(t);
    return { label: `Continue vol. ${volumeNumber(m.series, t)} · ch. ${abs}`, target: t };
  }
  return { label: `Continue ch. ${chapterOrdinalFor(t, p)}`, target: t };
}

export function renderInfo(kind, id) {
  const m = infoModel(kind, id);
  const root = el.infoScreen;
  root.innerHTML = "";
  if (!m) {
    go({ route: "library" });
    return;
  }

  // Backdrop — the cover blurred behind the hero. No cover → flat page.
  const bgUrl = coverUrlFor(m.coverBook);
  if (bgUrl) {
    root.append(
      h(
        "div",
        { class: "info-backdrop" },
        h("div", { class: "info-backdrop__img", style: `background-image:url("${bgUrl}")` }),
        h("div", { class: "info-backdrop__veil" })
      )
    );
  }

  // Bar — back · ⋯ (no title; the title lives in the page).
  root.append(
    h(
      "div",
      { class: "info-bar" },
      h("button", { class: "sbar__icon", "aria-label": "Back", onclick: () => go({ route: "library" }) }, svg(ICON.back)),
      h("div", { class: "info-bar__spacer" }),
      h("button", { class: "sbar__icon", "aria-label": "More", onclick: () => openInfoMenu(m) }, svg(ICON.more))
    )
  );

  const content = h("div", { class: "info-content" });

  // Hero.
  content.append(
    h(
      "div",
      { class: "info-hero" },
      coverNode(m.coverBook, "info-hero__cover"),
      h("div", { class: "info-hero__title" }, m.title),
      m.author && h("div", { class: "info-hero__author" }, m.author)
    )
  );

  // Primary action.
  const ci = continueInfo(m);
  content.append(
    h(
      "div",
      { class: "info-actions" },
      h(
        "button",
        { class: "pill-btn info-actions__continue", disabled: !ci.target, onclick: () => ci.target && openBook(ci.target.id) },
        ci.label
      )
    )
  );

  // Subject chips.
  if (m.subjects.length) {
    const chips = h("div", { class: "info-chips" });
    for (const sub of m.subjects.slice(0, 6)) chips.append(h("span", { class: "info-chip" }, sub));
    content.append(chips);
  }

  // Description — clamped to 4 lines with an inline "more".
  if (m.description) {
    const body = h("p", { class: "info-desc__text" }, stripHtml(m.description));
    const more = h("button", { class: "info-desc__more", onclick: () => { body.classList.add("expanded"); more.remove(); } }, "more");
    content.append(h("div", { class: "info-desc" }, body, more));
    // Drop "more" if the text isn't actually clipped.
    requestAnimationFrame(() => {
      if (body.scrollHeight <= body.clientHeight + 2) more.remove();
    });
  }

  // Metadata table — missing fields are omitted, never blanked.
  const rows = [];
  if (m.volumeCount != null) rows.push(["Volumes", String(m.volumeCount)]);
  rows.push(["Chapters", m.chapterCount.toLocaleString()]);
  const lang = formatLang(m.language);
  if (lang) rows.push(["Language", lang]);
  const pub = formatPublished(m.published);
  if (pub) rows.push(["Published", pub]);
  if (m.publisher) rows.push(["Publisher", m.publisher]);
  const size = formatBytes(m.byteSize);
  rows.push(["On this device", `${m.fileCount} file${m.fileCount === 1 ? "" : "s"}${size ? " · " + size : ""}`]);
  // Plain display rows; the route into the Chapters screen is the five-chapter
  // preview at the foot of the page (11b), not this table row.
  const table = h("div", { class: "info-table" });
  for (const [label, value] of rows) {
    table.append(
      h("div", { class: "info-trow" }, h("span", { class: "info-trow__k" }, label), h("span", { class: "info-trow__v" }, value))
    );
  }
  content.append(table);

  // Volumes block (series only). Tapping a row selects that volume; the chapter
  // list at the foot of the page then shows its chapters. Selection defaults to
  // the reading volume and survives in-page updates.
  let selId = null;
  if (m.kind === "series") {
    selId = m.volumes.some((v) => v.id === selectedVolumeId)
      ? selectedVolumeId
      : (m.currentVolume?.id || (m.volumes[0] && m.volumes[0].id) || null);
    setSelectedVolumeId(selId);
    content.append(h("div", { class: "lib-label info-vollabel" }, "Volumes"));
    let offset = 0;
    for (const b of m.volumes) {
      const count = chapterCount(b);
      const start = offset + 1;
      const end = offset + count;
      offset = end;
      content.append(volumeRow(m.series, b, start, end, selId));
    }
    content.append(
      h(
        "button",
        { class: "add-volume", onclick: () => addVolumeToSeries(m.series.id) },
        h("span", { class: "add-volume__plus" }, "+"),
        "Add a volume to this series"
      )
    );
  }

  // Every info page ends in a five-chapter preview (11b). For a series it tracks
  // the selected volume (rebuilt in place on selection); for a standalone it is
  // the book's own chapters.
  if (m.kind === "series") {
    const host = h("div", { class: "info-vol-preview" });
    renderVolumePreview(m, selId, host);
    content.append(host);
  } else {
    const pv = previewItemsFor(m);
    const preview = chapterPreview(pv.items, {
      scoped: false,
      anchorAbs: pv.anchorAbs,
      onSeeAll: () => openChapters(m.kind, m.id, { volId: pv.volId }),
    });
    if (preview) content.append(preview);
  }

  root.append(content);
  root.scrollTop = 0;
}

function volumeRow(s, book, start, end, selId) {
  const isSelected = book.id === selId;
  const pct = bookPercent(book);
  const p = progressMap[book.id];
  let statusText;
  if (pct >= 100) statusText = "finished";
  else if (p) statusText = "reading ch. " + (chapterOrdinalFor(book, p) + start - 1);
  else statusText = "not started";
  const title = "Vol. " + volumeNumber(s, book) + (stripVolume(displayTitle(book)) ? " · " + stripVolume(displayTitle(book)) : "");
  const row = h(
    "div",
    { class: "vrow" + (isSelected ? " vrow--current" : ""), dataset: { volId: book.id } },
    coverNode(book, "vrow__thumb"),
    h(
      "div",
      { class: "vrow__text" },
      h("div", { class: "vrow__title" }, title),
      h("div", { class: "vrow__sub" }, `Ch. ${start}–${end} · ${statusText}`)
    ),
    h("div", { class: "vrow__pct" }, pct >= 100 ? "100 %" : bookIsStarted(book) ? pct + " %" : "")
  );
  // Tap selects the volume — its chapters fill the list at the foot of the page.
  // Long-press raises the single-volume view (continue, edit details, remove).
  attachLongPress(row, {
    onLongPress: () => showVolumeSheet(s, book, start, end),
    onTap: () => selectVolume(book.id),
  });
  return row;
}

// Move the volume selection without re-rendering the whole info page, so tapping
// a row never jumps the scroll: shift the row highlight and rebuild the chapter
// list below for the newly-selected volume.
function selectVolume(volId) {
  if (!currentInfo || currentInfo.kind !== "series") return;
  setSelectedVolumeId(volId);
  el.infoScreen
    .querySelectorAll(".vrow")
    .forEach((r) => r.classList.toggle("vrow--current", r.dataset.volId === volId));
  const host = el.infoScreen.querySelector(".info-vol-preview");
  if (host) renderVolumePreview(infoModel("series", currentInfo.id), volId, host);
}

// The five-chapter preview for one volume of a series, rendered into `host`
// (rebuilt on each selection). Chapters are absolutely numbered; See-all opens
// the full Chapters screen filtered to this volume.
function renderVolumePreview(m, volId, host) {
  host.innerHTML = "";
  if (!m) return;
  const vol = m.volumes.find((v) => v.id === volId) || m.currentVolume || m.volumes[0];
  if (!vol) return;
  const model = chaptersModel("series", m.id);
  const items = model ? model.items.filter((it) => it.bookId === vol.id) : [];
  const preview = chapterPreview(items, {
    scoped: true,
    anchorAbs: model ? model.scrollAnchorAbs : null,
    onSeeAll: () => openChapters("series", m.id, { volId: vol.id }),
  });
  if (preview) host.append(preview);
}

async function confirmDeleteSeries(s) {
  const vols = seriesVolumes(s);
  const ok = await showConfirmSheet(
    "Delete this series?",
    `“${s.name}” and its ${vols.length} volume${vols.length === 1 ? "" : "s"} will be removed from this device — the files and your place in them. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  for (const b of vols) await deleteBook(b.id);
  go({ route: "library" });
}

async function confirmDeleteBook(b) {
  const ok = await showConfirmSheet(
    "Delete this book?",
    `“${displayTitle(b)}” will be removed from this device — the file and your place in it. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  await deleteBook(b.id);
  go({ route: "library" });
}

async function confirmDeleteVolume(book) {
  const ok = await showConfirmSheet(
    "Delete this volume?",
    `“${displayTitle(book)}” will be removed from this device — the file and your place in it. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  const seriesId = book.seriesId;
  await deleteBook(book.id);
  if (seriesId && seriesById(seriesId)) renderInfo("series", seriesId);
  else go({ route: "library" });
}

// The ⋯ overflow menu on the info page.
export function openInfoMenu(m) {
  if (m.kind === "series") {
    showActionSheet([
      { label: "Edit details", onClick: () => showEditDetails(m) },
      { label: "Series details", onClick: () => showSeriesDetails(m.series) },
      { label: "Delete series", danger: true, onClick: () => confirmDeleteSeries(m.series) },
    ]);
  } else {
    showActionSheet([
      { label: "Edit details", onClick: () => showEditDetails(m) },
      { label: "Delete book", danger: true, onClick: () => confirmDeleteBook(m.book) },
    ]);
  }
}

// =========================================================================
// Full-screen editors — Edit details (type over any field) and Series details
// (name, metadata source, volume order). Both live in the #editor overlay,
// dismissed by ✕ or Escape; only Save commits.
// =========================================================================
function closeEditor() {
  el.editor.hidden = true;
  el.editor.innerHTML = "";
}
function openEditorShell(title) {
  el.editor.innerHTML = "";
  const saveBtn = h("button", { class: "editor-save" }, "Save");
  el.editor.append(
    h(
      "div",
      { class: "editor-bar" },
      h("button", { class: "sbar__icon", "aria-label": "Cancel", onclick: () => closeOverlay() }, svg(ICON.close)),
      h("div", { class: "editor-bar__title" }, title),
      saveBtn
    )
  );
  const body = h("div", { class: "editor-body" });
  el.editor.append(body);
  el.editor.hidden = false;
  armOverlay(closeEditor);
  return { body, saveBtn };
}

// Edit details — type over any field; what's typed always wins. An emptied
// field drops the override and reverts to the file's value.
function showEditDetails(m) {
  const cur = {
    title: m.title,
    author: m.author,
    description: m.description,
    subjects: m.subjects.join(", "),
    language: m.language,
    published: m.published,
    publisher: m.publisher,
  };
  const { body, saveBtn } = openEditorShell("Edit details");
  body.append(h("p", { class: "editor-lead" }, "Type over anything the .epub got wrong. What you enter here always wins; clear a field to fall back to the file."));

  const inputs = {};
  const addField = (key, label, area) => {
    const input = area
      ? h("textarea", { class: "editor-input editor-input--area", rows: "5" })
      : h("input", { class: "editor-input", type: "text" });
    input.value = cur[key] || "";
    inputs[key] = input;
    body.append(h("label", { class: "editor-field" }, h("span", { class: "editor-field__label" }, label), input));
  };
  addField("title", "Title");
  addField("author", "Author");
  addField("description", "Description", true);
  addField("subjects", "Subjects (comma-separated)");
  addField("language", "Language");
  addField("published", "Published");
  addField("publisher", "Publisher");

  saveBtn.onclick = async () => {
    const val = (k) => inputs[k].value.trim();
    const subs = val("subjects").split(",").map((x) => x.trim()).filter(Boolean);
    if (m.kind === "series") {
      const s = m.series;
      if (val("title")) s.name = val("title"); // a series title is its name
      s.overrides = s.overrides || {};
      for (const k of META_FIELDS) {
        if (val(k)) s.overrides[k] = val(k);
        else delete s.overrides[k];
      }
      if (subs.length) s.overrides.subjects = subs;
      else delete s.overrides.subjects;
      await dbPut("series", s);
    } else {
      const b = m.book;
      b.overrides = b.overrides || {};
      for (const k of ["title", ...META_FIELDS]) {
        if (val(k)) b.overrides[k] = val(k);
        else delete b.overrides[k];
      }
      if (subs.length) b.overrides.subjects = subs;
      else delete b.overrides.subjects;
      await dbPut("books", b);
    }
    closeOverlay(() => renderInfo(m.kind, m.id));
  };
}

// A one-line summary of what a volume file actually contains, so choosing the
// metadata source is informed rather than a guess.
function volumeContentsLabel(b) {
  const parts = [b.coverBlob ? "Has cover" : "No cover", b.description ? "description" : "no description"];
  const n = (b.subjects || []).length;
  if (n) parts.push(`${n} subject${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Series details — name, which volume supplies cover/description, and volume
// order (drag to reorder; reordering sets a manual-order flag).
function showSeriesDetails(s) {
  const { body, saveBtn } = openEditorShell("Series details");
  let order = [...s.bookIds];
  let sourceId = (s.metadataSourceBookId && bookById(s.metadataSourceBookId) ? s.metadataSourceBookId : s.bookIds[0]) || null;
  let reordered = false;

  // Series name.
  const nameInput = h("input", { class: "editor-input", type: "text" });
  nameInput.value = s.name || "";
  body.append(h("label", { class: "editor-field" }, h("span", { class: "editor-field__label" }, "Series name"), nameInput));

  // Metadata source radio list.
  body.append(h("div", { class: "editor-section-label" }, "Cover and description from"));
  body.append(h("p", { class: "editor-lead" }, "The volumes disagree, so pick which file the page should use. Fields are never mixed across volumes."));
  const radioList = h("div", { class: "radio-list" });
  const renderRadios = () => {
    radioList.innerHTML = "";
    for (const b of order.map(bookById).filter(Boolean)) {
      const selected = b.id === sourceId;
      const row = h(
        "button",
        {
          class: "radio-row" + (selected ? " radio-row--on" : ""),
          onclick: () => { sourceId = b.id; renderRadios(); },
        },
        h("span", { class: "radio-dot" + (selected ? " radio-dot--on" : "") }, selected ? "✓" : ""),
        h(
          "span",
          { class: "radio-row__text" },
          h("span", { class: "radio-row__title" }, "Vol. " + volumeNumber(s, b) + (stripVolume(b.title) ? " · " + stripVolume(b.title) : "")),
          h("span", { class: "radio-row__sub" }, volumeContentsLabel(b))
        )
      );
      radioList.append(row);
    }
  };
  renderRadios();
  body.append(radioList);

  // Volume order — drag handles; chapter ranges recompute from the order.
  body.append(h("div", { class: "editor-section-label" }, "Volume order"));
  const orderList = h("div", { class: "order-list" });
  const updateRanges = () => {
    let off = 0;
    [...orderList.children].forEach((row, i) => {
      const b = bookById(order[i]);
      if (!b) return;
      const c = chapterCount(b);
      row.querySelector(".order-row__range").textContent = `Ch. ${off + 1}–${off + c}`;
      off += c;
    });
  };
  const renderOrder = () => {
    orderList.innerHTML = "";
    for (const id of order) {
      const b = bookById(id);
      if (!b) continue;
      const handle = h("span", { class: "order-row__handle", "aria-hidden": "true" }, svg(ICON.handle));
      const row = h(
        "div",
        { class: "order-row", dataset: { id } },
        handle,
        h("span", { class: "order-row__title" }, stripVolume(b.title) || b.title),
        h("span", { class: "order-row__range" }, "")
      );
      attachOrderDrag(handle, row, orderList, () => {
        order = [...orderList.children].map((r) => r.dataset.id);
        reordered = true;
        updateRanges();
      });
      orderList.append(row);
    }
    updateRanges();
  };
  renderOrder();
  body.append(orderList);

  saveBtn.onclick = async () => {
    if (nameInput.value.trim()) s.name = nameInput.value.trim();
    s.metadataSourceBookId = sourceId;
    const vols = order.map(bookById).filter(Boolean);
    s.bookIds = vols.map((b) => b.id);
    if (reordered) {
      s.manualOrder = true;
      vols.forEach((b, i) => { b.volumeIndex = i + 1; });
      await Promise.all(vols.map((b) => dbPut("books", b)));
    }
    await dbPut("series", s);
    closeOverlay(() => renderInfo("series", s.id));
  };
}

// =========================================================================
// Volume sheet (design 7a) — tapping a volume row raises this; it does not
// start reading. Continue / Chapters push the reader; Remove drops the volume.
// =========================================================================
function hideVolumeSheet() {
  el.volumeSheet.hidden = true;
  el.volumeCard.innerHTML = "";
}
function showVolumeSheet(s, book, start, end) {
  const total = seriesVolumes(s).length;
  const volNum = volumeNumber(s, book);
  const p = progressMap[book.id];
  const pct = bookPercent(book);
  const absCh = (p ? chapterOrdinalFor(book, p) : 1) + volumeChapterOffset(book);
  const volTitle = "Vol. " + volNum + (stripVolume(displayTitle(book)) ? " · " + stripVolume(displayTitle(book)) : "");
  let statusLine;
  if (pct >= 100) statusLine = "Finished · 100 %";
  else if (p) statusLine = `Reading ch. ${absCh} · ${pct} %`;
  else statusLine = "Not started";
  const continueLabel = pct >= 100 ? "Read again" : p ? `Continue ch. ${absCh}` : "Start reading";

  // File facts (11a): File · Size · Added — three plain rows.
  const facts = [
    book.fileName && ["File", book.fileName],
    formatBytes(book.fileBlob?.size) && ["Size", formatBytes(book.fileBlob.size)],
    formatAdded(book.addedAt) && ["Added", formatAdded(book.addedAt)],
  ].filter(Boolean);

  // Volume overflow menu (⋯) and the Edit-details editor both act on this
  // volume as if it were a standalone book.
  const editVolume = () => closeOverlay(() => showEditDetails(infoModel("book", book.id)));
  const removeVolume = () => closeOverlay(() => confirmDeleteVolume(book));

  const card = el.volumeCard;
  card.innerHTML = "";
  card.append(
    h("div", { class: "vsheet__handle" }),
    h(
      "div",
      { class: "vsheet__header" },
      coverNode(book, "vsheet__thumb"),
      h(
        "div",
        { class: "vsheet__hcol" },
        h("div", { class: "lib-label" }, `Volume ${volNum} of ${total}`),
        h("div", { class: "vsheet__title" }, volTitle),
        h("div", { class: "vsheet__sub" }, `${s.name} · ch. ${start}–${end}`),
        progressBar(pct, "card"),
        h("div", { class: "vsheet__status" }, statusLine)
      )
    ),
    h(
      "div",
      { class: "vsheet__actions" },
      h("button", { class: "pill-btn vsheet__continue", onclick: () => closeOverlay(() => openBook(book.id)) }, continueLabel)
    ),
    h(
      "div",
      { class: "vsheet__facts" },
      ...facts.map(([k, v]) => h("div", { class: "vsheet__fact" }, h("span", { class: "vsheet__fact-k" }, k), h("span", { class: "vsheet__fact-v" }, v)))
    ),
    h(
      "div",
      { class: "vsheet__textactions" },
      h("button", { class: "text-btn", onclick: editVolume }, "Edit details"),
      h("button", { class: "text-btn text-btn--danger", onclick: removeVolume }, "Remove from series")
    )
  );

  // Chapters preview last (11a) — facts and destructive actions must not sit
  // after a list the reader is scanning. Absolute numbers, this-volume count.
  const model = chaptersModel("series", s.id);
  const items = model ? model.items.filter((it) => it.bookId === book.id) : [];
  const preview = chapterPreview(items, {
    scoped: true,
    anchorAbs: model ? model.scrollAnchorAbs : null,
    onSeeAll: () => closeOverlay(() => openChapters("series", s.id, { volId: book.id })),
  });
  if (preview) card.append(preview);

  el.volumeSheet.hidden = false;
  armOverlay(hideVolumeSheet);
}
