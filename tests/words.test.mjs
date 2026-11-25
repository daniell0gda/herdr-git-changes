// Tests finding the word under the pointer and marking its other appearances in a line.
// Nothing here needs Herdr or git. Run: node tests/words.test.mjs
import { wordAt, wordStarts, markWord } from "../mods/git-changes/words.js";
import assert from "node:assert/strict";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

test("the word under a column, with where it starts", () => {
  const line = "  const total = sum(items_2, $x);";
  assert.deepEqual(wordAt(line, 2), { text: "const", start: 2 });
  assert.deepEqual(wordAt(line, 12), { text: "total", start: 8 });
  assert.deepEqual(wordAt(line, 22), { text: "items_2", start: 20 });
  assert.deepEqual(wordAt(line, 29), { text: "$x", start: 29 });
  assert.deepEqual(wordAt("größe = 1", 3), { text: "größe", start: 0 });
});

test("no word on a space, a sign or past the end", () => {
  assert.equal(wordAt("a = b", 1), null);
  assert.equal(wordAt("a = b", 2), null);
  assert.equal(wordAt("a = b", 40), null);
  assert.equal(wordAt("", 0), null);
});

test("only whole words count as appearances", () => {
  assert.deepEqual(wordStarts("total + subtotal + total_x + total", "total"), [0, 29]);
  assert.deepEqual(wordStarts("nothing here", "total"), []);
});

test("marking splits tokens at each appearance and loses no text", () => {
  const tokens = [{ kind: "keyword", text: "const " }, { kind: "plain", text: "row = rows[row];" }];
  const marked = markWord(tokens, "row");
  assert.equal(marked.map((p) => p.text).join(""), "const row = rows[row];");
  assert.deepEqual(marked.filter((p) => p.match !== undefined).map((p) => [p.text, p.match]), [["row", 6], ["row", 17]]);
  assert.ok(marked.every((p) => p.kind === (p.text === "const " ? "keyword" : "plain")), "pieces keep their token's kind");
});

test("an appearance that spans two tokens is marked in both", () => {
  const marked = markWord([{ kind: "a", text: "x foo" }, { kind: "b", text: "bar y" }], "foobar");
  assert.deepEqual(marked.filter((p) => p.match !== undefined).map((p) => [p.kind, p.text, p.match]), [["a", "foo", 2], ["b", "bar", 2]]);
});

test("no word, or a word that is not in the line, leaves the tokens as they are", () => {
  const tokens = [{ kind: "plain", text: "a b" }];
  assert.equal(markWord(tokens, null), tokens);
  assert.equal(markWord(tokens, "zzz"), tokens);
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
