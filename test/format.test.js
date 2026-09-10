// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { formatBytes, formatPublished, formatAdded, formatLang, stripHtml } from "../src/lib/format.js";

describe("formatBytes", () => {
  it("shows MB at or above 1 MB, KB below", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
  });
  it("never rounds a nonzero size down to 0 KB", () => {
    expect(formatBytes(10)).toBe("1 KB");
  });
  it("returns empty for zero / nullish", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(undefined)).toBe("");
  });
});

describe("formatPublished", () => {
  it("extracts the year", () => {
    expect(formatPublished("2019-04-01T00:00:00Z")).toBe("2019");
    expect(formatPublished("2019")).toBe("2019");
  });
  it("passes through a yearless string and handles empty", () => {
    expect(formatPublished("unknown")).toBe("unknown");
    expect(formatPublished("")).toBe("");
  });
});

describe("formatAdded", () => {
  it("formats a timestamp as day + month", () => {
    // Locale-dependent string, so just assert it is non-empty and mentions the day.
    const out = formatAdded(new Date("2024-06-15T12:00:00Z").getTime());
    expect(out).toMatch(/15/);
  });
  it("returns empty for a missing timestamp", () => {
    expect(formatAdded(0)).toBe("");
    expect(formatAdded(null)).toBe("");
  });
});

describe("formatLang", () => {
  it("maps known codes to language names", () => {
    expect(formatLang("en")).toBe("English");
    expect(formatLang("fr-FR")).toBe("French");
    expect(formatLang("JA")).toBe("Japanese");
  });
  it("passes an unknown code through and handles empty", () => {
    expect(formatLang("xx")).toBe("xx");
    expect(formatLang("")).toBe("");
  });
});

describe("stripHtml", () => {
  it("strips tags and keeps paragraph breaks as newlines", () => {
    const out = stripHtml("<p>First para.</p><p>Second para.</p>");
    expect(out).toBe("First para.\nSecond para.");
  });
  it("does not run scripts or leave markup", () => {
    const out = stripHtml("<p>Hi</p><script>window.x = 1</script>");
    expect(out).not.toMatch(/</);
    expect(out).toMatch(/Hi/);
  });
  it("collapses excess blank lines", () => {
    const out = stripHtml("<div>A</div><br><br><br><div>B</div>");
    expect(out).not.toMatch(/\n{3,}/);
  });
});
