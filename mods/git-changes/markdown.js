import { exec, readTextFile } from "herdr";
import * as G from "./git.js";

async function readRevision(revs, { root, on }) {
  for (const rev of revs) {
    const r = await exec("git", [...G.READ, "cat-file", "blob", rev], { cwd: root, on });
    if (r.code === 0) return r.stdout;
  }
  return null;
}

async function readSide(side, source) {
  if (!side) return null;
  if (side.worktree) return readTextFile(`${source.root}/${side.worktree}`, { on: source.on }).catch(() => null);
  return readRevision(side.revs, source);
}

/** Null when the file is not in the version `item` changes to. */
export function loadAfterText(item, path, { root, on, hasHead }) {
  return readSide(G.fileSides(item, { path, change: "modified" }, hasHead).after, { root, on });
}

/** The text of a single-file `item` before and after its change; a side the file isn't in is null. */
export async function loadMarkdown(item, { root, on, hasHead }) {
  const sides = G.fileSides(item, { path: item.path, change: "modified" }, hasHead);
  const [before, after] = await Promise.all([readSide(sides.before, { root, on }), readSide(sides.after, { root, on })]);
  return { before, after };
}
