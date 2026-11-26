const WORD = /[\p{L}\p{N}_$]+/gu;

/** The word that covers `column` of `text`, or null when that column is not inside a word. */
export function wordAt(text, column) {
  for (const match of text.matchAll(WORD)) {
    if (column >= match.index && column < match.index + match[0].length) return { text: match[0], start: match.index };
  }
  return null;
}

/** The start columns of every whole-word appearance of `word` in `text`. */
export function wordStarts(text, word) {
  return [...text.matchAll(WORD)].filter((match) => match[0] === word).map((match) => match.index);
}

function cutToken(token, offset, ranges, field) {
  const end = offset + token.text.length, pieces = [];
  let at = offset;
  for (const range of ranges.filter((r) => r.start < end && r.end > offset)) {
    if (range.start > at) pieces.push({ ...token, text: token.text.slice(at - offset, range.start - offset) });
    const to = Math.min(range.end, end);
    pieces.push({ ...token, text: token.text.slice(Math.max(at, range.start) - offset, to - offset), [field]: range.start });
    at = to;
  }
  if (at < end) pieces.push({ ...token, text: token.text.slice(at - offset) });
  return pieces;
}

function markRanges(tokens, ranges, field) {
  if (!ranges.length) return tokens;
  let offset = 0;
  return tokens.flatMap((token) => {
    const pieces = cutToken(token, offset, ranges, field);
    offset += token.text.length;
    return pieces;
  });
}

const joined = (tokens) => tokens.map((token) => token.text).join("");

/**
 * Splits `tokens` so each appearance of `word` is its own piece. A piece of an appearance carries
 * `match`: the column where that appearance starts. One appearance can span several pieces.
 */
export function markWord(tokens, word) {
  const ranges = word ? wordStarts(joined(tokens), word).map((start) => ({ start, end: start + word.length })) : [];
  return markRanges(tokens, ranges, "match");
}

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every appearance of `query` in `text`, ignoring case. */
export function findAll(text, query) {
  if (!query) return [];
  return [...text.matchAll(new RegExp(escapePattern(query), "giu"))].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** Splits `tokens` like `markWord`, for each appearance of `query` in any case; its pieces carry `found`. */
export function markFound(tokens, query) {
  return markRanges(tokens, findAll(joined(tokens), query), "found");
}
