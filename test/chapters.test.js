import { describe, it, expect } from "vitest";
import {
  baseHref,
  isFrontMatter,
  readableChapters,
  frontMatterCount,
  frontMatterEntries,
  leadingFrontMatterCount,
  chapterCount,
  chapterOrdinalFor,
  chapterDisplay,
  markEarlierDone,
  flatten,
  previewWindow,
  scrollAnchorFor,
} from "../src/lib/chapters.js";

const ch = (label, href) => ({ label, href });

describe("baseHref", () => {
  it("strips the fragment", () => {
    expect(baseHref("OEBPS/ch1.xhtml#frag")).toBe("OEBPS/ch1.xhtml");
    expect(baseHref("ch1.xhtml")).toBe("ch1.xhtml");
    expect(baseHref(null)).toBe("");
  });
});

describe("isFrontMatter", () => {
  it("flags known front-matter labels", () => {
    ["Information", "Table of Contents", "Contents", "Cover", "Title Page", "Copyright", "Colophon"].forEach(
      (l) => expect(isFrontMatter(l)).toBe(true)
    );
  });
  it("flags Project Gutenberg boilerplate and licence pages", () => {
    expect(isFrontMatter("The Project Gutenberg eBook")).toBe(true);
    expect(isFrontMatter("License")).toBe(true);
    expect(isFrontMatter("Licence")).toBe(true);
  });
  it("flags trailing back matter (the notes page every scraped volume ends with)", () => {
    ["Notes", "Note", "Author's Notes", "Authors Note", "Translator's Notes", "Afterword", "Foreword", "Acknowledgements", "About the Author"].forEach(
      (l) => expect(isFrontMatter(l)).toBe(true)
    );
  });
  it("does not flag real chapters", () => {
    expect(isFrontMatter("Chapter 1")).toBe(false);
    expect(isFrontMatter("The Sanctuary")).toBe(false);
    // The whole-label anchor keeps a real chapter that merely mentions a
    // boilerplate word from being hidden.
    expect(isFrontMatter("Chapter 5: Notes")).toBe(false);
    expect(isFrontMatter("Footnotes of a Madman")).toBe(false);
  });
});

describe("readableChapters", () => {
  it("drops front matter", () => {
    const entries = [ch("Cover", "c"), ch("Contents", "t"), ch("Chapter 1", "1"), ch("Chapter 2", "2")];
    expect(readableChapters(entries).map((e) => e.label)).toEqual(["Chapter 1", "Chapter 2"]);
  });
  it("falls back to the original list if everything looked like front matter", () => {
    const entries = [ch("Cover", "c"), ch("Contents", "t")];
    expect(readableChapters(entries)).toEqual(entries);
  });
  it("handles empty / nullish", () => {
    expect(readableChapters([])).toEqual([]);
    expect(readableChapters(null)).toEqual([]);
  });
});

describe("chapterCount", () => {
  it("counts readable chapters, not spine items", () => {
    const book = { chapters: [ch("Cover", "c"), ch("Chapter 1", "1"), ch("Chapter 2", "2")], spineCount: 9 };
    expect(chapterCount(book)).toBe(2);
  });
  it("falls back to spineCount then 1 when there is no TOC", () => {
    expect(chapterCount({ chapters: [], spineCount: 5 })).toBe(5);
    expect(chapterCount({ chapters: [] })).toBe(1);
  });
});

describe("frontMatterCount", () => {
  it("counts all boilerplate, front and back", () => {
    const book = { chapters: [ch("Cover", "c"), ch("Contents", "t"), ch("Chapter 1", "1"), ch("Notes", "n")] };
    expect(frontMatterCount(book)).toBe(3);
  });
});

describe("frontMatterEntries", () => {
  it("returns the boilerplate entries, front and back, in order — the 'Notes & extras' group", () => {
    const book = { chapters: [ch("Cover", "c"), ch("Contents", "t"), ch("Chapter 1", "1"), ch("Notes", "n")] };
    expect(frontMatterEntries(book).map((e) => e.label)).toEqual(["Cover", "Contents", "Notes"]);
  });
  it("is empty when every entry is a real chapter", () => {
    expect(frontMatterEntries({ chapters: [ch("Chapter 1", "1"), ch("Chapter 5: Notes", "2")] })).toEqual([]);
  });
});

describe("leadingFrontMatterCount", () => {
  it("counts only the boilerplate before the first real chapter", () => {
    const book = { chapters: [ch("Cover", "c"), ch("Contents", "t"), ch("Chapter 1", "1"), ch("Notes", "n")] };
    // Cover + Contents lead; the trailing Notes page must not be counted, or a
    // spine-index fallback would land one chapter early.
    expect(leadingFrontMatterCount(book)).toBe(2);
  });
});

// A multi-volume series: every scraped volume ends with a "Notes" page. It must
// be dropped so counts stay honest and the cross-volume offset never drifts.
describe("readableChapters + chapterCount with a trailing notes page", () => {
  const volume = {
    chapters: [ch("Information", "i"), ch("Table of Contents", "t"), ch("Chapter 1: Nightmare Begins", "0"), ch("Chapter 2: Slave Caravan", "1"), ch("Notes", "n")],
  };
  it("keeps only the real chapters", () => {
    expect(readableChapters(volume.chapters).map((e) => e.label)).toEqual(["Chapter 1: Nightmare Begins", "Chapter 2: Slave Caravan"]);
  });
  it("counts 2, not 3 (the notes page no longer inflates it)", () => {
    expect(chapterCount(volume)).toBe(2);
  });
});

describe("chapterDisplay", () => {
  it("reads the number and clean title from the label (colon form)", () => {
    expect(chapterDisplay(ch("Chapter 96: Exile"), 1)).toEqual({ num: 96, title: "Exile" });
  });
  it("handles the no-separator form some volumes use", () => {
    expect(chapterDisplay(ch("Chapter 2721 The Ship of Theseus"), 1)).toEqual({ num: 2721, title: "The Ship of Theseus" });
  });
  it("prefers the label number over the positional fallback", () => {
    // Position says 1, but the book states 96 — the stated number wins.
    expect(chapterDisplay(ch("Chapter 96: Exile"), 1).num).toBe(96);
  });
  it("falls back to the positional number and raw label for bare titles", () => {
    expect(chapterDisplay(ch("Prologue"), 7)).toEqual({ num: 7, title: "Prologue" });
    expect(chapterDisplay(ch("Ashen Barrens"), 3)).toEqual({ num: 3, title: "Ashen Barrens" });
  });
  it("keeps a numbered-but-titleless chapter's title empty", () => {
    expect(chapterDisplay(ch("Chapter 96"), 5)).toEqual({ num: 96, title: "" });
  });
});

describe("chapterOrdinalFor", () => {
  const book = {
    chapters: [ch("Cover", "c"), ch("Chapter 1", "1"), ch("Chapter 2", "2"), ch("Chapter 3", "3")],
  };
  it("returns 1 with no progress", () => {
    expect(chapterOrdinalFor(book, null)).toBe(1);
  });
  it("locates by chapter label over the readable TOC (front matter never inflates it)", () => {
    expect(chapterOrdinalFor(book, { chapterLabel: "Chapter 2" })).toBe(2);
  });
  it("falls back to chapterIndex minus front matter when the label is unknown", () => {
    // spine index 3 (0-based) with 1 front-matter page => readable ordinal 3
    expect(chapterOrdinalFor(book, { chapterLabel: "gone", chapterIndex: 3 })).toBe(3);
  });
});

describe("markEarlierDone", () => {
  it("marks every readable chapter before the given href complete", () => {
    const book = { chapters: [ch("Chapter 1", "1"), ch("Chapter 2", "2"), ch("Chapter 3", "3")] };
    const chapters = {};
    markEarlierDone(book, "3", chapters);
    expect(chapters["1"]).toEqual({ pct: 100, cfi: null, done: true });
    expect(chapters["2"]).toEqual({ pct: 100, cfi: null, done: true });
    expect(chapters["3"]).toBeUndefined(); // the target itself is not touched
  });
  it("preserves an existing cfi and leaves already-done chapters alone", () => {
    const book = { chapters: [ch("Chapter 1", "1"), ch("Chapter 2", "2")] };
    const chapters = { 1: { pct: 40, cfi: "cfi-1", done: false } };
    markEarlierDone(book, "2", chapters);
    expect(chapters["1"]).toEqual({ pct: 100, cfi: "cfi-1", done: true });
  });
});

describe("flatten", () => {
  it("flattens a nested TOC with depth tags", () => {
    const toc = [
      { label: "Part I", href: "p1", subitems: [{ label: "Chapter 1", href: "c1" }] },
      { label: "Part II", href: "p2" },
    ];
    expect(flatten(toc)).toEqual([
      { label: "Part I", href: "p1", depth: 0 },
      { label: "Chapter 1", href: "c1", depth: 1 },
      { label: "Part II", href: "p2", depth: 0 },
    ]);
  });
});

describe("previewWindow", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ absNum: i + 1, state: "unread" }));
  it("returns all items when there are five or fewer", () => {
    const few = items.slice(0, 4);
    expect(previewWindow(few, null)).toEqual(few);
  });
  it("centres on the anchor (two before, anchor, two after)", () => {
    const win = previewWindow(items, 10);
    expect(win.map((i) => i.absNum)).toEqual([8, 9, 10, 11, 12]);
  });
  it("clamps to the start and end", () => {
    expect(previewWindow(items, 1).map((i) => i.absNum)).toEqual([1, 2, 3, 4, 5]);
    expect(previewWindow(items, 20).map((i) => i.absNum)).toEqual([16, 17, 18, 19, 20]);
  });
  it("shows the first five when there is no anchor and no current row", () => {
    expect(previewWindow(items, null).map((i) => i.absNum)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("scrollAnchorFor", () => {
  const items = [
    { absNum: 1, bookId: "a", localIndex: 0 },
    { absNum: 2, bookId: "a", localIndex: 1 },
    { absNum: 3, bookId: "b", localIndex: 0 },
  ];
  it("prefers the current item's absolute number", () => {
    expect(scrollAnchorFor(items, { absNum: 2 }, "a", 1)).toBe(2);
  });
  it("falls back to the last-read chapter by book + local index", () => {
    expect(scrollAnchorFor(items, null, "b", 0)).toBe(3);
  });
  it("returns null for an unopened book", () => {
    expect(scrollAnchorFor(items, null, null, -1)).toBeNull();
  });
});
