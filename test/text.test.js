import { describe, it, expect } from "vitest";
import {
  normalize,
  parseVolumeIndex,
  stripVolume,
  seriesKey,
  toRoman,
  parseChapterLabel,
  longestCommonName,
} from "../src/lib/text.js";

describe("normalize", () => {
  it("lowercases and collapses non-alphanumerics to single spaces", () => {
    expect(normalize("Shadow  Slave!!")).toBe("shadow slave");
    expect(normalize("A_Study-in.Scarlet")).toBe("a study in scarlet");
  });
  it("handles empty / nullish input", () => {
    expect(normalize("")).toBe("");
    expect(normalize(null)).toBe("");
    expect(normalize(undefined)).toBe("");
  });
});

describe("parseVolumeIndex", () => {
  it("reads explicit volume markers", () => {
    expect(parseVolumeIndex("Shadow Slave Vol. 2")).toBe(2);
    expect(parseVolumeIndex("Shadow Slave volume 12")).toBe(12);
    expect(parseVolumeIndex("Book 3")).toBe(3);
    expect(parseVolumeIndex("Part 4")).toBe(4);
    expect(parseVolumeIndex("something v7")).toBe(7);
  });
  it("falls back to a trailing bare number", () => {
    expect(parseVolumeIndex("Herodotus 2")).toBe(2);
  });
  it("returns null when there is no number", () => {
    expect(parseVolumeIndex("Frankenstein")).toBeNull();
    expect(parseVolumeIndex("")).toBeNull();
    expect(parseVolumeIndex(null)).toBeNull();
  });
});

describe("stripVolume", () => {
  it("removes volume markers and trailing separators", () => {
    expect(stripVolume("Shadow Slave Vol. 2")).toBe("Shadow Slave");
    expect(stripVolume("Poe - v3")).toBe("Poe");
    expect(stripVolume("Quixote: Part 1")).toBe("Quixote");
  });
  it("leaves a bare title untouched", () => {
    expect(stripVolume("Frankenstein")).toBe("Frankenstein");
  });
});

describe("seriesKey", () => {
  it("keys by normalized title-without-volume + author", () => {
    const a = { title: "Shadow Slave Vol. 1", author: "Guilt" };
    const b = { title: "Shadow Slave Vol. 2", author: "Guilt" };
    expect(seriesKey(a)).toBe(seriesKey(b));
  });
  it("distinguishes different authors", () => {
    const a = { title: "Shadow Slave", author: "Guilt" };
    const b = { title: "Shadow Slave", author: "Someone" };
    expect(seriesKey(a)).not.toBe(seriesKey(b));
  });
});

describe("toRoman", () => {
  it("converts small volume indexes", () => {
    expect(toRoman(1)).toBe("I");
    expect(toRoman(4)).toBe("IV");
    expect(toRoman(9)).toBe("IX");
    expect(toRoman(14)).toBe("XIV");
    expect(toRoman(2024)).toBe("MMXXIV");
  });
  it("returns empty for zero / negative / nullish", () => {
    expect(toRoman(0)).toBe("");
    expect(toRoman(-2)).toBe("");
    expect(toRoman(null)).toBe("");
  });
});

describe("parseChapterLabel", () => {
  it("splits a 'Chapter N: Title' label", () => {
    expect(parseChapterLabel("Chapter 230: Precarious Alliance")).toEqual({
      num: 230,
      title: "Precarious Alliance",
    });
    expect(parseChapterLabel("Ch. 12 - The Sanctuary")).toEqual({ num: 12, title: "The Sanctuary" });
  });
  it("reads a bare number", () => {
    expect(parseChapterLabel("42")).toEqual({ num: 42, title: "" });
  });
  it("reads 'N. Title' and 'N — Title'", () => {
    expect(parseChapterLabel("7. Awakening")).toEqual({ num: 7, title: "Awakening" });
  });
  it("returns num:null for a bare title", () => {
    expect(parseChapterLabel("Ashen Barrens")).toEqual({ num: null, title: "Ashen Barrens" });
  });
});

describe("longestCommonName", () => {
  it("finds the shared prefix, trimmed of trailing separators", () => {
    expect(longestCommonName(["Shadow Slave 1", "Shadow Slave 2"])).toBe("Shadow Slave");
    expect(longestCommonName(["Poe - Vol 1", "Poe - Vol 2"])).toBe("Poe - Vol");
  });
  it("is case-insensitive when comparing", () => {
    expect(longestCommonName(["shadow slave A", "Shadow Slave B"])).toBe("shadow slave");
  });
  it("handles a single title and an empty list", () => {
    expect(longestCommonName(["Frankenstein"])).toBe("Frankenstein");
    expect(longestCommonName([])).toBe("");
  });
});
