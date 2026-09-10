// -------------------------------------------------------------------------
// Display formatters for the info page, volume sheet and metadata table.
// Pure functions of their inputs — no app state, no DOM mutation — so they are
// unit-tested directly (see test/format.test.js).
// -------------------------------------------------------------------------

export function formatBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

export function formatPublished(v) {
  if (!v) return "";
  const m = String(v).match(/\d{4}/);
  return m ? m[0] : String(v);
}

export function formatAdded(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  } catch {
    return "";
  }
}

const LANG_NAMES = {
  en: "English",
  fr: "French",
  ja: "Japanese",
  zh: "Chinese",
  es: "Spanish",
  de: "German",
  ko: "Korean",
  ru: "Russian",
  it: "Italian",
  pt: "Portuguese",
};
export function formatLang(code) {
  if (!code) return "";
  const k = String(code).toLowerCase().split(/[-_]/)[0];
  return LANG_NAMES[k] || code;
}

// Strip HTML from a description without loading any resources (DOMParser does
// not run scripts or fetch), keeping paragraph breaks as newlines.
export function stripHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.querySelectorAll("p, br, div, li").forEach((n) => n.after(doc.createTextNode("\n")));
    return (doc.body.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return String(html);
  }
}
