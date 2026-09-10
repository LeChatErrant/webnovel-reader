// -------------------------------------------------------------------------
// DOM plumbing shared by every screen: the tiny element builder, the inline
// SVG icons, the cover-image cache, the collected element refs, and the two
// touch gesture primitives (long-press, drag-reorder).
// -------------------------------------------------------------------------

// Tiny DOM builder. Titles/authors come from untrusted epub metadata, so
// everything is set as text nodes — never innerHTML — unless marked `html`.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "dataset") Object.assign(e.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
export const svg = (html) => {
  const span = document.createElement("span");
  span.innerHTML = html;
  span.setAttribute("aria-hidden", "true");
  return span;
};
export const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  handle: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>',
  sort: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// -------------------------------------------------------------------------
// Cover object URLs — created lazily from stored blobs and cached per book,
// revoked only when a book is removed.
// -------------------------------------------------------------------------
export const coverUrls = new Map();
export function coverUrlFor(book) {
  if (!book?.coverBlob) return null;
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
  return coverUrls.get(book.id);
}
export function coverNode(book, cls = "cover") {
  const url = book && coverUrlFor(book);
  if (url) return h("div", { class: cls }, h("img", { class: "cover__img", src: url, alt: "", loading: "lazy", draggable: "false" }));
  return h("div", { class: cls + " cover--ph" });
}
export function progressBar(pct, variant) {
  return h("div", { class: "pbar pbar--" + variant }, h("div", { class: "pbar__fill", style: `width:${pct}%` }));
}

// -------------------------------------------------------------------------
// Collected DOM refs, filled by collectRefs() after DOMContentLoaded. Every
// module reads `el.foo`; the object is mutated in place so all importers share
// the same live refs.
// -------------------------------------------------------------------------
export const el = {};
export function collectRefs() {
  const ids = {
    libBody: "lib-body",
    libImport: "lib-import",
    libSearch: "lib-search",
    libSearchRow: "lib-search-row",
    libSearchInput: "lib-search-input",
    infoScreen: "info-screen",
    chaptersScreen: "chapters-screen",
    topTitle: "book-title",
    chapterTitle: "chapter-title",
    titleBlock: "title-block",
    btnToc: "btn-toc",
    btnPrev: "btn-prev",
    btnNext: "btn-next",
    drawer: "drawer",
    drawerHome: "drawer-home",
    drawerBook: "drawer-book",
    drawerCover: "drawer-cover",
    drawerBookTitle: "drawer-book-title",
    drawerBookSub: "drawer-book-sub",
    drawerVolumes: "drawer-volumes",
    scrim: "scrim",
    tocList: "toc-list",
    viewer: "viewer",
    selectBar: "select-bar",
    selectCancel: "select-cancel",
    selectCount: "select-count",
    selectGroup: "select-group",
    selectDelete: "select-delete",
    suggestSheet: "suggest-sheet",
    suggestScrim: "suggest-scrim",
    suggestBody: "suggest-body",
    suggestGroup: "suggest-group",
    suggestKeep: "suggest-keep",
    nameSheet: "name-sheet",
    nameScrim: "name-scrim",
    nameTitle: "name-title",
    nameInput: "name-input",
    nameConfirm: "name-confirm",
    nameCancel: "name-cancel",
    confirmSheet: "confirm-sheet",
    confirmScrim: "confirm-scrim",
    confirmTitle: "confirm-title",
    confirmBody: "confirm-body",
    confirmOk: "confirm-ok",
    confirmCancel: "confirm-cancel",
    volumeSheet: "volume-sheet",
    volumeScrim: "volume-scrim",
    volumeCard: "volume-card",
    actionSheet: "action-sheet",
    actionScrim: "action-scrim",
    actionCard: "action-card",
    editor: "editor",
    installNote: "install-note",
    installSheet: "install-sheet",
    installScrim: "install-scrim",
    installSheetClose: "install-sheet-close",
    appVersion: "app-version",
    checkUpdate: "check-update",
    updateStatus: "update-status",
    updateBanner: "update-banner",
    updateText: "update-banner-text",
    updateReload: "update-reload",
    updateDismiss: "update-dismiss",
    fileInput: "file-input",
  };
  for (const [k, id] of Object.entries(ids)) el[k] = document.getElementById(id);
}

// -------------------------------------------------------------------------
// Touch gestures.
// -------------------------------------------------------------------------
// A long-press primitive that survives a touchscreen. The naïve version
// cancelled on *any* pointermove, so finger jitter killed the press before it
// fired — on a phone it never triggered at all. Here the timer is only
// cancelled once movement passes a small threshold (a real scroll), so a still
// finger reliably reaches the hold.
export function attachLongPress(node, { onLongPress, onTap, canStart = () => true, delay = 450, moveTolerance = 10 }) {
  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener("pointerdown", (e) => {
    if (!canStart()) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      onLongPress();
    }, delay);
  });
  node.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > moveTolerance || Math.abs(e.clientY - startY) > moveTolerance) clear();
  });
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("pointerleave", clear);
  // On Android a long-press fires `contextmenu` (the "Download image / open in
  // new tab" popup on covers), which collides with our own hold-to-select.
  // iOS's `-webkit-touch-callout: none` handles the equivalent there; this is
  // the cross-browser counterpart. Suppress it whenever a press could start.
  node.addEventListener("contextmenu", (e) => {
    if (canStart() || longPressed) e.preventDefault();
  });
  node.addEventListener("click", (e) => {
    if (longPressed) {
      e.preventDefault();
      e.stopPropagation();
      longPressed = false;
      return;
    }
    onTap();
  });
}

// Pointer-based drag reorder for one handle. Uses pointer capture so the drag
// survives the finger leaving the handle, and reorders DOM live; the caller
// syncs its model on each move.
export function attachOrderDrag(handle, row, list, onReorder) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    row.classList.add("dragging");
    const move = (ev) => {
      const others = [...list.querySelectorAll(".order-row:not(.dragging)")];
      const after = others.find((r) => ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (after) list.insertBefore(row, after);
      else list.append(row);
      onReorder();
    };
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    // Pointer capture keeps the drag alive when the finger leaves the handle.
    // It can throw for a stale/synthetic pointer id — never let that abort the
    // drag we just wired up.
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
}
