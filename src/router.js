// =========================================================================
// Routing — library is the root; info, chapters and reader are pushed on top —
// plus the overlay/Back history stack that lets sheets close before the route
// changes. This module owns the current route, the history entries and the
// popstate unwind; the screen modules own their own rendering.
// =========================================================================
import { bookById, seriesById } from "./state.js";
import { renderReader, closeDrawer, destroyRendition, setCurrentBook } from "./reader.js";
import { renderLibrary, exitSelection, isSelecting } from "./library.js";
import { renderInfo } from "./info.js";
import { renderChapters, teardownChapters } from "./chapters.js";

function setRouteChrome(route) {
  document.getElementById("app").dataset.route = route;
  if (route !== "reader") {
    closeDrawer();
    destroyRendition();
  }
  if (route !== "library" && isSelecting()) exitSelection();
  if (route !== "chapters") teardownChapters();
}

export function renderCurrentRoute() {
  const route = document.getElementById("app").dataset.route;
  if (route === "info" && currentInfo) renderInfo(currentInfo.kind, currentInfo.id);
  else if (route === "chapters") return; // the chapters screen manages its own updates
  else renderLibrary();
}

export let currentInfo = null; // { kind: "book" | "series", id } when on the info route
// On a series info page, which volume's chapters the bottom list shows. Tapping a
// volume row selects it; navigating to a series resets it so it defaults to the
// reading volume. Null → default (the reading volume / first).
export let selectedVolumeId = null;
export const setSelectedVolumeId = (id) => { selectedVolumeId = id; };

// Apply a route state (without pushing history).
async function applyState(state) {
  const s = state || { route: "library" };
  if (s.route === "reader" && s.id) {
    currentInfo = null;
    setRouteChrome("reader");
    const lib = bookById(s.id);
    if (lib) {
      setCurrentBook(lib);
      await renderReader(lib);
    } else {
      go({ route: "library" });
    }
  } else if (s.route === "info" && s.id) {
    currentInfo = { kind: s.kind || "series", id: s.id };
    selectedVolumeId = null;
    setRouteChrome("info");
    renderInfo(currentInfo.kind, currentInfo.id);
  } else if (s.route === "chapters" && s.id) {
    currentInfo = null;
    setRouteChrome("chapters");
    renderChapters(s.kind || "book", s.id, s.volId);
  } else {
    currentInfo = null;
    setRouteChrome("library");
    renderLibrary();
  }
}
// Navigate + push history.
export function go(state, push = true) {
  const cur = document.getElementById("app").dataset.route;
  if (state.route === "reader" && state.id) {
    currentInfo = null;
    setRouteChrome("reader");
  } else if (state.route === "info" && state.id) {
    currentInfo = { kind: state.kind || "series", id: state.id };
    selectedVolumeId = null;
    setRouteChrome("info");
    renderInfo(currentInfo.kind, currentInfo.id);
  } else if (state.route === "chapters" && state.id) {
    currentInfo = null;
    setRouteChrome("chapters");
    renderChapters(state.kind || "book", state.id, state.volId);
  } else {
    currentInfo = null;
    setRouteChrome("library");
    renderLibrary();
  }
  activeState = state;
  if (push && cur !== undefined) history.pushState(state, "");
  else history.replaceState(state, "");
}
export function openInfo(kind, id) {
  go({ route: "info", kind, id });
}
// Kept for callers that jump straight back to a series (e.g. the volume
// boundary card).
export function openSeries(id) {
  openInfo("series", id);
}

// The screen the phone's Back gesture should land on — the *structural* parent,
// not wherever you happened to come from. reader → the book's info page (its
// series page for a volume), chapters → the same info page, info → the library.
// This makes Back predictable no matter the path in (a book opened straight into
// the reader from the Continue card still backs out to its info page).
let activeState = { route: "library" };

// -------------------------------------------------------------------------
// Overlays vs. Back. Sheets and the editor are dismissable layers that sit on
// top of a route (a volume sheet, the ⋯ action sheet, a confirm/name prompt,
// the details editor). The phone's Back gesture must close the *topmost* such
// layer before it ever changes route — otherwise Back navigated the page out
// from under an open sheet.
//
// Every overlay, when shown, pushes one history entry (`_overlay`) and registers
// a DOM-hide fn on `overlayStack`. Both Back and every in-app dismissal funnel
// through the same `popstate` unwind: `closeOverlay(after)` calls `history.back()`
// (which the browser turns into a popstate), and the handler pops one layer, runs
// its hide fn, then runs `after` (used to open the next screen/sheet). Pushing on
// open guarantees Back always has a layer entry to pop even at the library root.
const overlayStack = []; // DOM-hide fns, innermost last
let pendingAfter = null; // ran once, inside the popstate that closes a layer
export const overlayOpen = () => overlayStack.length > 0;
export function armOverlay(hide) {
  overlayStack.push(hide);
  history.pushState({ ...activeState, _overlay: overlayStack.length }, "");
}
// Close the top overlay (from a button, the scrim, Escape, or a chained action).
// `after` runs after the layer is torn down — navigate or raise the next sheet
// there so it happens inside the single popstate, never racing the unwind.
export function closeOverlay(after = null) {
  if (!overlayStack.length) {
    if (after) after();
    return;
  }
  pendingAfter = after;
  history.back();
}
function bookInfoParent(bookId) {
  const b = bookById(bookId);
  if (b?.seriesId && seriesById(b.seriesId)) return { route: "info", kind: "series", id: b.seriesId };
  return { route: "info", kind: "book", id: bookId };
}
function structuralParent(state) {
  if (!state) return null;
  if (state.route === "reader" && state.id) return bookInfoParent(state.id);
  if (state.route === "chapters" && state.id)
    return state.kind === "series" ? { route: "info", kind: "series", id: state.id } : bookInfoParent(state.id);
  if (state.route === "info") return { route: "library" };
  return null; // library / unknown — the root; let Back leave the app
}
window.addEventListener("popstate", (e) => {
  // An overlay is open → Back (or an in-app dismissal) closes just that layer.
  // The browser already consumed its `_overlay` entry, so we only tear down the
  // DOM and run any chained action; the route underneath is untouched.
  if (overlayStack.length) {
    const hide = overlayStack.pop();
    hide();
    const after = pendingAfter;
    pendingAfter = null;
    if (after) after();
    return;
  }
  const parent = structuralParent(activeState);
  if (parent) {
    // Redirect Back to the structural parent and keep the app in control of the
    // entry the browser just popped to.
    applyState(parent);
    activeState = parent;
    history.replaceState(parent, "");
  } else {
    // At the root screen: follow the browser's own Back (out of the app).
    applyState(e.state);
    activeState = e.state && e.state.route ? e.state : { route: "library" };
  }
});
