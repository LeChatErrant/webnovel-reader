// -------------------------------------------------------------------------
// Reference books for the "in other words" recap (info page) — a fixed,
// curated set of well-known novels with approximate word counts, spanning
// short to very long so some comparison always lands somewhere legible
// ("< 0.1×" to a four-digit multiple). Word counts are widely-cited
// approximations, not exact — this is a fun comparison, not a citation.
// -------------------------------------------------------------------------
export const COMPARISON_BOOKS = [
  { title: "The Old Man and the Sea", author: "Ernest Hemingway", words: 27000 },
  { title: "Animal Farm", author: "George Orwell", words: 30000 },
  { title: "The Great Gatsby", author: "F. Scott Fitzgerald", words: 47000 },
  { title: "The Catcher in the Rye", author: "J. D. Salinger", words: 73000 },
  { title: "Harry Potter and the Philosopher's Stone", author: "J. K. Rowling", words: 77000 },
  { title: "1984", author: "George Orwell", words: 88000 },
  { title: "The Hobbit", author: "J. R. R. Tolkien", words: 95000 },
  { title: "To Kill a Mockingbird", author: "Harper Lee", words: 100000 },
  { title: "Pride and Prejudice", author: "Jane Austen", words: 122000 },
  { title: "Moby-Dick", author: "Herman Melville", words: 206000 },
  { title: "A Game of Thrones", author: "George R. R. Martin", words: 284000 },
  { title: "The Lord of the Rings", author: "J. R. R. Tolkien", words: 470000 },
  { title: "War and Peace", author: "Leo Tolstoy", words: 587000 },
];

// "634×", "3.2×", "0.08×", "< 0.1×" — mirrors how the multiplier is read
// aloud: whole numbers once they're big, one decimal in the middle, and a
// floor once the fraction gets too small to feel meaningful.
export function formatMultiplier(x) {
  if (x >= 10) return Math.round(x).toLocaleString() + "×";
  if (x >= 1) return (Math.round(x * 10) / 10).toFixed(1) + "×";
  if (x >= 0.1) return (Math.round(x * 100) / 100).toFixed(2) + "×";
  return "< 0.1×";
}

// Below this, even the closest-fitting reference book is a rounding error
// ("< 0.1× The Old Man and the Sea") — not worth a comparison yet.
const MIN_RELEVANT_RATIO = 0.01;

// The single most legible comparison: the reference book whose word count is
// closest to `words`, multiplicatively (closest to a 1:1 ratio on a log
// scale, so "read half of" and "read double" count as equally close). Saying
// "< 0.1× The Hobbit" or "8,000× The Great Gatsby" is technically true but
// tells you nothing — so anything that doesn't clear the relevance floor
// returns null and the caller shows nothing.
export function bestComparison(words) {
  if (!words) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const ref of COMPARISON_BOOKS) {
    const ratio = words / ref.words;
    const distance = Math.abs(Math.log(ratio));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { ref, ratio };
    }
  }
  return best && best.ratio >= MIN_RELEVANT_RATIO ? best : null;
}
