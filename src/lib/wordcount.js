// -------------------------------------------------------------------------
// Word count for a book, used only by the info page's recap comparison. Not
// computed at import time — it means opening the epub and walking its whole
// spine, which is wasted work for a book that's never opened. Computed once,
// lazily, the first time the info page needs it, then cached on the book
// record so it's never redone.
// -------------------------------------------------------------------------
import ePub from "epubjs";
import { stripHtml } from "./format.js";
import { dbPut } from "../db.js";

function countWords(text) {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Total words across every spine item (front/back matter included — it's a
// negligible sliver of a whole novel, and we're comparing whole books).
async function extractWordCount(book) {
  if (!book.fileBlob) return 0;
  const buffer = await book.fileBlob.arrayBuffer();
  const b = ePub(buffer);
  try {
    await b.ready;
    const items = b.spine?.spineItems || [];
    let total = 0;
    for (const item of items) {
      try {
        total += countWords(stripHtml(await b.archive.getText(item.href)));
      } catch {
        /* unreadable spine item — skip it */
      }
    }
    return total;
  } finally {
    try {
      b.destroy();
    } catch {
      /* ignore */
    }
  }
}

// Resolves the book's word count, computing and persisting it if this is the
// first time it's been asked for.
export async function ensureWordCount(book) {
  if (book.wordCount != null) return book.wordCount;
  book.wordCount = await extractWordCount(book);
  await dbPut("books", book);
  return book.wordCount;
}
