// -------------------------------------------------------------------------
// Title / text parsing — volume extraction, series-key normalization, roman
// numerals and chapter-label parsing. All pure functions of their string (or
// plain-object) inputs, unit-tested in test/text.test.js.
// -------------------------------------------------------------------------

export const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Pull a volume number out of a title or filename ("vol 2", "v2", "part 2").
export function parseVolumeIndex(text) {
  if (!text) return null;
  const m = text.match(/\b(?:vol(?:ume)?\.?|v|part|book)\s*(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\b\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// Title with any volume marker stripped, for series naming + duplicate keys.
export function stripVolume(title) {
  return (title || "")
    .replace(/\b(?:vol(?:ume)?\.?|v|part|book)\s*\d{1,3}\b/gi, "")
    .replace(/[\s\-–—:·|]+$/g, "")
    .trim();
}

// Series identity key: title-without-volume + author, both normalized. Two books
// with the same key are look-alikes eligible for grouping.
export const seriesKey = (book) => normalize(stripVolume(book.title)) + "|" + normalize(book.author);

// Roman numeral for the title-collision cue (11c). Volume indexes are small, so
// the full 1–3999 converter is overkill but harmless.
export function toRoman(n) {
  if (!n || n < 1) return "";
  const map = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "",
    r = n;
  for (const [v, sym] of map)
    while (r >= v) {
      out += sym;
      r -= v;
    }
  return out;
}

// Split a TOC label into its own embedded chapter number (if any) and a clean
// title. Many books label chapters "Chapter 230: Precarious Alliance" (or
// "Ch. 230 - ...", "230. ..."); the embedded number is the one the reader sees
// in the top bar, and it can differ from the positional ordinal when the book
// carries front matter. Bare-title books ("Ashen Barrens") return num: null so
// callers can fall back to the positional ordinal.
export function parseChapterLabel(label) {
  const s = (label || "").trim();
  let m = s.match(/^(?:chapters?|chap|ch|episodes?|ep|parts?|vol(?:ume)?)\.?\s*(\d+)\s*[:.\-–—)]*\s*(.*)$/i);
  if (m) return { num: parseInt(m[1], 10), title: m[2].trim() };
  if (/^\d+$/.test(s)) return { num: parseInt(s, 10), title: "" };
  m = s.match(/^(\d+)\s*[:.\-–—)]\s*(.*)$/);
  if (m) return { num: parseInt(m[1], 10), title: m[2].trim() };
  return { num: null, title: s };
}

// The longest shared (case-insensitive) title prefix across a set of books, used
// to prefill the "Name this series" sheet when grouping look-alikes.
export function longestCommonName(titles) {
  if (!titles.length) return "";
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i].toLowerCase() === t[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-–—:·|]+$/g, "").trim();
}
