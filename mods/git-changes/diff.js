// Diffs: loading one for a file, a stash, a commit or every change, and drawing
// it unified (one column) or split (before | after) in the main area.
//
// The panel doesn't draw diffs itself. Picking something posts it to
// shared("git-changes.view") under the space's id, and opens (or selects and
// renames) one tab per space whose only pane is this mod with props
// { role: "diff", space }. That tab reads the shared entry, so every later pick
// reuses it; closing the tab ends it, and the next pick makes a new one.
// The one/two-column choice is shared("git-changes.layout"), so both the
// panel's toggle and the tab's own reach every diff.
//
// diffRow() and the virtual-list layout come from Herdr's shipped `changes`
// mod (Apache-2.0). The before/after pairing follows the same rule as
// better-changes by Tawsif Aqib (https://github.com/munza/herdr-mods, Apache-2.0):
// replacements pair by position inside one block, never across a hunk or a
// context line. That code isn't used here; git.js has its own splitRows().
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, props, shared, setShared, spaces, panes, run, notify, openOverlay, terminals } from "herdr";
import * as G from "./git.js";
import * as C from "./comments.js";
import { icon, menuHeight } from "./menu.js";
import { previewImage, pruneCache } from "./images.js";
import { fitSize, formatBytes } from "./imageinfo.js";
import { highlightRows, syntaxColors, Token } from "./syntax.js";
import { loadMarkdown } from "./markdown.js";
import { splitMermaid, drawDiagram, diagramKey, isDarkColor, Part } from "./mermaid.js";

const MAX = 5000;
const clip = (line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
const ROW = 20, HEAD = 24;
const MAX_IMAGES = 20, CAPTION = 22, CELL_PAD = 10, STATE_HEIGHT = 64, MANY_IMAGES_HEIGHT = 320, SPLIT_COLUMNS = 2;
const THREAD_INDENT = 54, THREAD_MARGIN = 16, MIN_CARD = 240, CHAR_WIDTH = 7.25, LINE = 18;
const TEXT_PAD = 4;
const MARKDOWN_PAD = 16, MARKDOWN_GAP = 12, MIN_DIAGRAM = 120, MAX_DIAGRAM_HEIGHT = 4000;
const CARD_PAD = 10, CARD_PAD_Y = 6, CARD_BORDER = 1, ROW_PAD_Y = 4, BLOCK_GAP = 4, COMPOSE_INPUT = 60, CLOSE_STRIP = 26;
const CARD_FRAME = 2 * (ROW_PAD_Y + CARD_PAD_Y + CARD_BORDER);
const COMPOSE_HEIGHT = CARD_FRAME + COMPOSE_INPUT + BLOCK_GAP + LINE;
const MENU_WIDTH = 200, MARK = 18, MARK_ICON = 14, ANSWER_POLL_MS = 1500, SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], SPINNER_MS = 80;
const mono = () => settings().font_family ?? "JetBrains Mono";

const diffHeader = (path) => `diff --git a/${path} b/${path}`;
const binaryLines = (path) => (G.imageType(path) ? [`Binary files /dev/null and b/${path} differ`] : ["Binary file · no text diff"]);

async function untrackedBody(root, on, path) {
  const type = G.imageType(path);
  if (type && type !== G.SVG) return binaryLines(path);
  const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
  if (text === null) return type ? binaryLines(path) : ["Cannot preview this file (binary, too large, or unreadable)"];
  if (text.includes("\0")) return binaryLines(path);
  if (!text) return ["Empty new file"];
  const n = G.countLines(text);
  return [`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 3000).map((l) => `+${l}`)];
}

async function untrackedLines(root, on, path) {
  const lead = G.imageType(path) ? ["new file mode 100644"] : [];
  return [...lead, ...(await untrackedBody(root, on, path))];
}

const showsUntracked = (item) => item.area === "all";
const isSingleFile = (item) => item.area === "file" || item.area === "base-file";
const isBase = (item) => item.area === "base" || item.area === "base-file";
const isMarkdownFile = (item) => isSingleFile(item) && G.isMarkdown(item.path);

// The diff's lines, ready for G.diffRows. `untracked` lists the untracked paths an "all" diff shows too.
export async function loadDiff(item, { root, on, hasHead, untracked = [] }) {
  if (item.untracked) return [...(G.imageType(item.path) ? [diffHeader(item.path)] : []), ...(await untrackedLines(root, on, item.path))];
  let lines = [];
  for (const args of G.diffArgs(item, hasHead)) {
    const r = await exec("git", [...G.READ, ...args], { cwd: root, on });
    if (r.code !== 0) throw new Error(G.gitError(r));
    lines.push(...r.stdout.replace(/\n$/, "").split("\n").filter((l, i, a) => l || i < a.length - 1));
  }
  if (showsUntracked(item)) {
    for (const path of untracked.slice(0, 50)) lines.push(diffHeader(path), ...(await untrackedLines(root, on, path)));
  }
  if (isSingleFile(item) && !lines.some((l) => l.startsWith("@@") || l.startsWith("Binary") || /^[-+ ]?Subproject/.test(l)))
    lines = [item.submodule ? `Submodule: ${item.submodule}` : item.binary ? "Binary file changed" : "No text diff available"];
  if (!lines.length) lines = ["No changes"];
  return lines.slice(0, MAX).map(clip);
}

export const itemTitle = (item) => item.area === "all" ? "All changes" : item.area === "base" ? `All commits since ${item.baseName}`
  : item.area === "stash" ? `${item.ref} · ${item.subject}` : item.area === "commit" ? `${item.short} · ${item.subject}` : item.path;
export const itemName = (item) => item.area === "all" ? "All changes" : item.area === "base" ? `Since ${item.baseName}`
  : item.area === "stash" ? item.ref : item.area === "commit" ? item.short : item.path.split("/").pop();
export const getLayout = () => (shared("git-changes.layout") === "split" ? "split" : "unified");
export const setLayout = (layout) => setShared("git-changes.layout", layout);

// Show `item` of the repository at { root, on } in this space's diff tab, making the tab if it's gone.
export function showInTab(spaceId, item, source) {
  const views = shared("git-changes.view") ?? {};
  const old = views[spaceId], tab = liveTab(spaceId, old?.tab);
  // Fast double picks: a tab asked for in the last 1.5 s is still coming.
  const opening = !tab && old?.opening && Date.now() - old.opening < 1500;
  // Entries of spaces that are gone are dropped on the way.
  const live = new Set(spaces().map((sp) => sp.id));
  const kept = Object.fromEntries(Object.entries(views).filter(([id]) => live.has(id)));
  setShared("git-changes.view", { ...kept, [spaceId]: { item: JSON.parse(JSON.stringify(item)), source, at: Date.now(), tab, opening: tab ? null : opening ? old.opening : Date.now() } });
  if (tab) { run("tab.rename", { id: tab, name: itemName(item) }); run("tab.select", { id: tab }); }
  else if (!opening) run("tab.new", { space: spaceId, name: itemName(item), mod: "git-changes", props: { role: "diff", space: spaceId } });
}

// The diff tab of a space, if it's still open. The tab writes its own id into its entry.
function liveTab(spaceId, id) {
  return id && spaces().find((s) => s.id === spaceId)?.tabs.some((t) => t.id === id) ? id : null;
}

export class DiffView {
  init(cx) {
    this.space = props().space;
    this.listId = `gc-diff-${Math.random().toString(36).slice(2)}`;
    this.width = 300; this.offset = 0; this.bodyWidth = 0; this.bodyHeight = 0; this.imageVersion = 0;
    this.previews = new Map(); this.previewing = false;
    this.uid = `gcd-${Math.random().toString(36).slice(2)}`;
    this.comments = []; this.commentsFile = null; this.saving = Promise.resolve(null);
    this.providers = C.cachedProviders(null); this.providersOn = undefined;
    this.asking = new Set(); this.reading = new Set(); this.failures = new Map(); this.target = null; this.threadVersion = 0; this.display = null;
    this.menuActions = {}; this.menuSerial = 0; this.pickSeen = shared("git-changes.pick")?.at; this.pressSide = "right"; this.pressX = null;
    this.composer = TextareaState.new({ placeholder: "Comment on this line", rows: 3 });
    this.composer.on("submit", (e, cx) => { if (!e.shift) this.send(cx); });
    this.clearRows();
    cx.spawn(async () => pruneCache());
    this.sync(cx);
    // Picks arrive through shared state, which re-renders this copy; files change under it.
    cx.timer.every(10000, (cx) => this.reload(cx));
    cx.timer.every(ANSWER_POLL_MS, (cx) => this.pollAnswers(cx));
  }

  entry() { return (shared("git-changes.view") ?? {})[this.space]; }

  clearRows() {
    this.rows = []; this.pairs = null; this.signature = null; this.heights = null;
    this.imageRows = []; this.added = 0; this.removed = 0; this.markdown = null; this.diagrams = new Map();
  }

  // Record this tab's id the first time it's seen, so the panel reuses it:
  // the tab in this space holding a git-changes pane, the shown one first.
  claim() {
    const e = this.entry();
    if (!e || e.tab) return;
    const space = spaces().find((s) => s.id === this.space);
    if (!space) return;
    const tabs = new Map(space.tabs.map((t) => [t.id, t]));
    const mine = panes().filter((p) => p.mod === "git-changes" && tabs.has(p.tab));
    const tab = (mine.find((p) => tabs.get(p.tab).active) ?? mine[0])?.tab;
    if (tab) setShared("git-changes.view", { ...(shared("git-changes.view") ?? {}), [this.space]: { ...e, tab, opening: null } });
  }

  sync(cx) {
    const e = this.entry();
    const id = e ? `${e.at}` : null;
    if (id === this.seen) return;
    this.seen = id;
    if (!e) { this.item = null; this.clearRows(); return; }
    if (!e.tab) cx.spawn(async () => this.claim());
    const repository = `${e.source.on ?? ""}:${e.source.root}`;
    this.item = e.item; this.root = e.source.root; this.on = e.source.on ?? null;
    this.clearRows(); this.offset = 0; this.error = null; this.target = null; this.changed();
    if (this.root !== this.watched && !this.on) this.watch(this.root, cx);
    if (this.on !== this.providersOn) this.refreshProviders(this.on, cx);
    if (repository !== this.repository) this.loadThreads(repository, cx);
    this.reload(cx);
  }

  // --- comment threads --------------------------------------------------------

  changed() { this.threadVersion++; }

  refreshProviders(on, cx) {
    this.providersOn = on;
    this.providers = C.cachedProviders(on);
    cx.spawn(async (cx) => {
      const list = await C.loadProviders(on);
      if (this.providersOn !== on) return;
      this.providers = list; this.changed(); cx.notify();
    });
  }

  selectedProvider() { return C.resolveProvider(C.getProvider(), this.providers); }

  composerProvider() {
    const existing = this.target?.id ? this.commentById(this.target.id) : null;
    const selected = this.selectedProvider();
    if (!existing) return selected;
    const key = C.providerKeyOf(existing, selected.key);
    return { key, name: existing.providerName || C.resolveProvider(key, this.providers).name };
  }

  providerMenu(cx) {
    const current = this.selectedProvider();
    this.menu(this.providers.map((p) => ({
      label: p.name, check: p.key === current.key,
      run: () => { C.setProvider(p.key); this.changed(); },
    })));
    cx.notify();
  }

  commentById(id) { return this.comments.find((c) => c.id === id) ?? null; }

  loadThreads(repository, cx) {
    const root = this.root, on = this.on;
    this.repository = repository; this.comments = []; this.commentsFile = null; this.failures.clear();
    cx.spawn(async (cx) => {
      const file = on ? null : await C.commentsFile(root, on).catch(() => null);
      const comments = await C.loadComments(file, on);
      if (repository !== this.repository) return;
      this.commentsFile = file; this.comments = comments; this.changed(); cx.notify();
    });
  }

  /** Applies `change` to the comments now, then to the file; saves run one after another, and the last one's result is kept. */
  save(change, cx, file = this.commentsFile) {
    this.comments = change(this.comments); this.changed();
    if (!file) return;
    const saving = this.saving = this.saving.then(() => C.updateComments(file, change)).catch((e) => {
      notify({ title: "Comment not saved", body: String(e?.message ?? e), level: "error" });
      return null;
    });
    cx.spawn(async (cx) => {
      const list = await saving;
      if (list && saving === this.saving && file === this.commentsFile) { this.comments = list; this.changed(); cx.notify(); }
    });
  }

  openComposer(target) {
    const key = (t) => (t?.id ? `t${t.id}` : t?.anchor ? JSON.stringify(t.anchor) : null);
    this.target = key(target) === key(this.target) ? null : target;
    this.changed();
    if (!this.target) return;
    this.composer.set_value("");
    this.composer.focus();
  }

  closeComposer() { this.target = null; this.changed(); }

  send(cx) {
    const text = this.composer.value().trim(), target = this.target;
    if (!text || !target) return;
    const message = { from: "you", text, at: Date.now() };
    const existing = target.id ? this.commentById(target.id) : null;
    if (target.id && (!existing || this.asking.has(target.id))) return;
    const comment = existing ?? this.newComment(target.anchor, message);
    this.save(existing ? C.withMessage(existing.id, message) : C.withComment(comment), cx);
    this.composer.set_value(""); this.closeComposer();
    this.ask(comment.id, cx);
    cx.notify();
  }

  newComment(anchor, message) {
    const row = this.rows.find((r) => C.isAnchor(r, anchor));
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return { id, ...anchor, context: row ? C.contextOf(this.rows, row) : `${anchor.kind}${anchor.text}`, session: null, cwd: null, at: message.at, thread: [message] };
  }

  ask(id, cx) {
    const comment = this.commentById(id);
    if (!comment || this.asking.has(id)) return;
    const provider = C.providerKeyOf(comment, this.selectedProvider().key);
    const source = { root: this.root, on: this.on, space: this.space, provider, providers: this.providers, taken: new Set(this.comments.map((c) => c.session).filter(Boolean)) };
    const file = this.commentsFile;
    this.asking.add(id); this.failures.delete(id); this.changed();
    cx.spawn(async (cx) => {
      try { this.save(C.withFields(id, await C.deliver(comment, source)), cx, file); }
      catch (e) { this.failures.set(id, String(e?.message ?? e)); }
      finally { this.asking.delete(id); this.changed(); cx.notify(); }
    });
  }

  /** Looks for answers to the threads waiting on their sessions, once each session's turn is over. */
  pollAnswers(cx) {
    const list = terminals();
    const statuses = this.comments.map((c) => `${c.id}:${C.sessionTerminal(c, list)?.status ?? "-"}`).join(" ");
    if (statuses !== this.statuses) { this.statuses = statuses; this.changed(); cx.notify(); }
    for (const comment of this.comments) {
      const id = comment.id, session = C.sessionTerminal(comment, list);
      if (!C.awaitsAnswer(comment) || !C.hasSession(comment) || this.asking.has(id) || this.reading.has(id) || this.failures.has(id)) continue;
      if (session?.status === "working" || session?.status === "blocked") continue;
      this.readAnswer(comment, Boolean(session), cx);
    }
  }

  readAnswer(comment, running, cx) {
    const id = comment.id, file = this.commentsFile, on = this.on;
    this.reading.add(id);
    cx.spawn(async (cx) => {
      try {
        const text = await C.readAnswer(comment, on);
        if (text) this.save(C.withMessage(id, { from: C.providerKeyOf(comment, C.DEFAULT_PROVIDER), text, at: Date.now() }), cx, file);
        else if (!running) this.failures.set(id, "Its session ended without an answer · right-click → Ask again");
      } catch (e) { this.failures.set(id, String(e?.message ?? e)); }
      finally { this.reading.delete(id); this.changed(); cx.notify(); }
    });
  }

  deleteThread(id, cx) {
    const comment = this.commentById(id), on = this.on;
    if (!comment) return;
    if (this.target?.id === id) this.closeComposer();
    this.failures.delete(id);
    this.save(C.withoutComment(id), cx);
    cx.spawn(async () => C.removeSession(comment, on));
  }

  closeSession(comment, cx) {
    cx.spawn(async (cx) => { await C.closeSession(comment); this.changed(); cx.notify(); });
  }

  pressed(ev) {
    this.pressX = ev.local_position ? ev.local_position.x / (settings().zoom ?? 1) : null;
  }

  isOnCloseStrip(x) {
    const right = THREAD_INDENT + this.cardWidth();
    return x !== null && x >= right - CLOSE_STRIP && x <= right;
  }

  clickThread(id, x, cx) {
    const comment = this.commentById(id);
    if (comment && C.sessionTerminal(comment) && this.isOnCloseStrip(x)) this.closeSession(comment, cx);
    else this.openComposer({ id });
  }

  clickRow(key, cx) {
    const x = this.pressX;
    this.pressX = null;
    if (key.startsWith("t")) this.clickThread(key.slice(1), x, cx);
    else if (key.startsWith("r")) {
      const row = this.lineAt(Number(key.slice(1)));
      if (!row) return;
      const threads = this.display?.placed.get(row);
      this.openComposer(threads ? { id: threads.at(-1).id } : { anchor: C.anchorOf(row) });
    } else return;
    cx.notify();
  }

  lineAt(index) {
    const base = getLayout() === "split" ? this.pairs : this.rows;
    const lines = base?.[index] ? C.linesOf(base[index]) : [];
    return lines.length > 1 && this.pressSide === "right" ? lines[1] : lines[0] ?? null;
  }

  threadMenu(key, cx) {
    const comment = key.startsWith("t") ? this.commentById(key.slice(1)) : null;
    if (!comment) return;
    const answer = C.lastAnswer(comment), canAsk = C.awaitsAnswer(comment) && !this.asking.has(comment.id);
    const session = C.sessionTerminal(comment);
    this.menu([
      session ? { label: "Open session", icon: "diff", run: () => run("terminal.peek", { terminal: session.address }) } : null,
      { label: "Reply", icon: "plus", run: () => this.openComposer({ id: comment.id }) },
      canAsk ? { label: "Ask again", icon: "refresh", run: (cx) => this.ask(comment.id, cx) } : null,
      answer ? { label: "Copy answer", icon: "copy", copy: answer } : null,
      { separator: true },
      { label: "Delete thread", icon: "trash", danger: true, run: (cx) => this.deleteThread(comment.id, cx) },
    ]);
    cx.notify();
  }

  menu(items) {
    const actions = this.menuActions = {}, serial = ++this.menuSerial;
    const out = items.filter(Boolean).map((it, i) => {
      if (!it.run) return it;
      const { run: action, ...rest } = it, id = `m${serial}-${i}`;
      actions[id] = action;
      return { ...rest, id };
    });
    openOverlay({ mod: "git-changes", kind: "popup", at: "pointer", width: MENU_WIDTH, height: menuHeight(out), props: { role: "menu", owner: this.uid, items: out } });
  }

  takePick(cx) {
    const pick = shared("git-changes.pick");
    if (!pick || pick.owner !== this.uid || pick.at === this.pickSeen) return;
    this.pickSeen = pick.at;
    const action = this.menuActions[pick.id];
    this.menuActions = {};
    if (action) cx.spawn(async (cx) => { action(cx); cx.notify(); });
  }

  watch(root, cx) {
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root && this.item?.area !== "commit") this.reload(cx); } }
      catch { if (this.watched === root) this.watched = null; }
    });
  }

  reload(cx) {
    if (!this.item) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    const item = this.item, root = this.root, on = this.on, seen = this.seen;
    cx.spawn(async (cx) => {
      let changed = true;
      try {
        const git = (args) => exec("git", [...G.READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
        let untracked = [];
        if (showsUntracked(item)) {
          const r = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
          untracked = r.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
        }
        const hasHead = head.code === 0;
        const lines = await loadDiff(item, { root, on, hasHead, untracked });
        if (seen !== this.seen) return;
        const signature = lines.join("\n");
        if (signature === this.signature && !this.error) { changed = false; return; }
        const markdown = isMarkdownFile(item) ? await loadMarkdown(item, { root, on, hasHead }) : null;
        if (seen !== this.seen) return;
        this.signature = signature; this.markdown = markdown;
        this.showLines(lines, item);
        this.error = null;
        this.loadImages(item, { root, on, hasHead }, seen, cx);
      } catch (e) { if (seen === this.seen) this.error = String(e?.message ?? e); }
      // A pick that came in meanwhile asked for another load (`again`), or changed `seen`: load it now.
      finally { this.loading = false; if (changed) cx.notify(); if (this.again || seen !== this.seen) this.reload(cx); }
    });
  }

  showLines(lines, item) {
    this.rows = highlightRows(C.attachPaths(G.diffRows(lines, { headers: !isSingleFile(item) }), item)); this.pairs = null; this.heights = null;
    this.imageRows = this.rows.filter((r) => r.kind === "img");
    this.added = this.rows.filter((r) => r.kind === "+").length;
    this.removed = this.rows.filter((r) => r.kind === "-").length;
    this.width = Math.max(300, ...this.rows.filter((r) => r.kind !== "img").map((r) => r.text.length * 7 + 20));
  }

  previewKey(item, row) { return `${item.area}:${item.ref ?? item.hash ?? item.base ?? ""}:${row.path}:${row.change}`; }

  // Previews already known stay on screen while the next ones load, so a refresh doesn't blink.
  loadImages(item, source, seen, cx) {
    this.imageRows.forEach((row, i) => {
      const key = this.previewKey(item, row);
      row.preview = this.previews.get(key) ?? null;
      if (i >= MAX_IMAGES) { row.preview = { limit: true }; return; }
      cx.spawn(async (cx) => {
        const preview = await previewImage(item, row, source);
        if (seen !== this.seen) return;
        this.previews.set(key, preview); row.preview = preview; this.imageVersion++; cx.notify();
      });
    });
  }

  // --- drawing ----------------------------------------------------------------

  toggleCell(t, { id, name, tip, on, pick }) {
    return h_flex().id(`gc-diff-${id}`).size(22).items_center().justify_center().rounded(5).cursor_pointer().tooltip(tip)
      .text_color(on ? t.accent : t.muted).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => { pick(); cx.notify(); })
      .child(svg(icon(name)).size(13));
  }

  toggleGroup(t, cells) {
    return h_flex().p(2).gap(2).flex_none().rounded(7).border_1().border_color(t.border).children(cells.map((cell) => this.toggleCell(t, cell)));
  }

  toggle(t, layout) {
    const cell = (id, name, tip) => ({ id, name, tip, on: layout === id, pick: () => setLayout(id) });
    return this.toggleGroup(t, [cell("unified", "rows", "One column"), cell("split", "columns", "Two columns: before | after")]);
  }

  previewToggle(t) {
    const cell = (id, name, tip, preview) => ({ id, name, tip, on: this.previewing === preview, pick: () => { this.previewing = preview; } });
    return this.toggleGroup(t, [cell("changes", "diff", "Changes", false), cell("preview", "eye", "Preview", true)]);
  }

  providerButton(t) {
    const current = this.selectedProvider();
    return h_flex().id("gc-diff-provider").h(26).px(8).gap(4).flex_none().items_center().rounded(7).border_1().border_color(t.border)
      .cursor_pointer().text_size(11).text_color(t.muted).tooltip("Review comment agent")
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.providerMenu(cx))
      .child(svg(icon("message-square")).size(11).flex_none())
      .child(div().child(current.name));
  }

  header(t, layout) {
    const add = this.added, del = this.removed;
    const what = this.item.area === "commit" ? `Commit ${this.item.short} · ${this.item.author} · ${this.item.when}`
      : this.item.area === "stash" ? `Stash ${this.item.ref}`
      : isBase(this.item) ? `Commits since ${this.item.baseName} (${this.item.base.slice(0, 7)}..${this.item.head.slice(0, 7)})` : "Working tree and index against HEAD";
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(38).px(12).gap(8).items_center()
        .child(svg(icon(this.item.area === "commit" ? "commit" : this.item.area === "stash" ? "stash" : "file")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.item.area === "commit" ? this.item.subject : itemTitle(this.item)))
        .when(add > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(`−${del}`)))
        .when(isMarkdownFile(this.item), (e) => e.child(this.previewToggle(t)))
        .child(this.providerButton(t))
        .child(this.toggle(t, layout))
        .child(h_flex().id("gc-diff-close").size(24).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).tooltip("Close")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { const tab = this.entry()?.tab; if (tab) run("tab.close", { id: tab }); })
          .child(svg(icon("x")).size(13))))
      .child(h_flex().h(22).px(12).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${what} · ${this.root}`))
        .child(div().child(this.loading ? "Loading…" : "")));
  }

  hasThread(line) { return Boolean(this.display?.placed.has(line)); }

  markIcon(name, t) { return svg(icon(name)).size(MARK_ICON).mx((MARK - MARK_ICON) / 2).flex_none().text_color(t.accent); }

  commentMark(line, t) {
    return C.isLine(line) && this.hasThread(line) ? this.markIcon("message-square", t) : div().w(MARK).flex_none();
  }

  /** A layer over the whole line that shows the new-comment icon only while the pointer is on the line: a hover style changes only its own element, never a child's colour. */
  newCommentLayer(id, t) {
    return h_flex().id(`${id}-new`).absolute().inset_0().opacity(0).hover((s) => s.opacity(1)).child(this.markIcon("message-square-plus", t));
  }

  commentable(element, line, t, id) {
    return element.when(C.isLine(line), (e) => e.id(id).relative().hover((s) => s.bg(t.accent + "33"))
      .when(!this.hasThread(line), (e) => e.child(this.newCommentLayer(id, t))));
  }

  /** The text part of a line. Its background is opaque, so the hover background of the line shows only in the line-number gutter. */
  lineText(tint, t, ...cells) {
    return h_flex().flex_1().min_w(0).h_full().bg(t.background)
      .child(h_flex().size_full().min_w(0).pl(TEXT_PAD).gap(8).when(Boolean(tint), (e) => e.bg(tint)).children(cells));
  }

  unifiedRow(row, t, key) {
    const { kind, old, number, text } = row;
    if (kind === "f") return div().w_full().px(12).h(HEAD).flex_none().flex().items_center().truncate().bg(t.raised).border_t(1).border_color(t.border).font_semibold().text_color(t.foreground).child(text);
    if (kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.foreground;
    const tint = kind === "+" || kind === "-" ? color + "18" : null;
    return this.commentable(h_flex().w_full().h(ROW).flex_none().gap(8).when(Boolean(tint), (e) => e.bg(tint)), row, t, `line-${key}`)
      .child(this.commentMark(row, t))
      .child(div().w(38).flex_none().text_right().text_color(t.dim).child(kind === "-" ? String(number) : kind === " " ? String(old) : ""))
      .child(div().w(38).flex_none().text_right().text_color(t.dim).child(kind === "+" || kind === " " ? String(number) : ""))
      .child(this.lineText(tint, t,
        div().w(10).flex_none().text_color(color).child(kind === "+" || kind === "-" ? kind : ""),
        this.code(h_flex().flex_1().min_w(0).whitespace_nowrap(), row, kind === " " ? t.foreground : color, t)));
  }

  code(element, row, plain, t) {
    if (!row?.tokens) return element.text_color(plain).child(row?.text ?? "");
    const colors = syntaxColors(t);
    return element.text_color(t.foreground)
      .children(row.tokens.map(({ kind, text }) => div().flex_none().when(kind !== Token.Plain, (e) => e.text_color(colors[kind])).child(text)));
  }

  // One row of both columns. Both sides move by the same horizontal offset, so they stay lined up.
  splitRow(row, t, key) {
    if (row.kind !== "pair") return this.unifiedRow(row, t, key);
    const side = (entry, left) => {
      const kind = entry?.kind, color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.foreground;
      const number = !entry ? "" : left ? String(kind === " " ? entry.old : entry.number) : String(entry.number);
      const tint = !entry ? t.raised + "88" : kind === "+" || kind === "-" ? color + "18" : null;
      return this.commentable(h_flex().flex_1().min_w(0).h_full().gap(6).items_center().overflow_hidden()
        .when(!left, (e) => e.border_l(1).border_color(t.border))
        .when(Boolean(tint), (e) => e.bg(tint)), entry, t, `line-${key}-${left ? "left" : "right"}`)
        .child(this.commentMark(entry, t))
        .child(div().w(38).flex_none().text_right().text_color(t.dim).child(number))
        .child(this.lineText(tint, t, div().flex_1().min_w(0).overflow_hidden()
          .child(this.code(h_flex().w(this.width).flex_none().ml(-this.offset).whitespace_nowrap(), entry, kind === " " ? t.foreground : color, t))));
    };
    return h_flex().w_full().h(ROW).flex_none().child(side(row.left, true)).child(side(row.right, false));
  }

  isStacked(row, layout) { return layout === "unified" && row.change === "modified"; }

  imageBox(row, layout) {
    const columns = layout === "split" ? SPLIT_COLUMNS : 1;
    const width = Math.max(120, Math.floor((this.bodyWidth || 600) / columns) - 2 * CELL_PAD);
    if (this.imageRows.length !== 1) return { width, height: MANY_IMAGES_HEIGHT };
    const cells = this.isStacked(row, layout) ? 2 : 1;
    return { width, height: Math.max(120, Math.floor((this.bodyHeight || 640) / cells) - CAPTION - 2 * CELL_PAD) };
  }

  imageCell(label, side, row, box) {
    const cell = { label, side, display: null, height: STATE_HEIGHT };
    if (!row.preview) return { ...cell, state: "loading" };
    if (row.preview.limit) return { ...cell, state: "limit" };
    if (!side) return { ...cell, state: "none" };
    if (side.error) return { ...cell, state: "error" };
    const square = Math.min(box.width, box.height);
    const display = side.size ? fitSize(side.size, box.width, box.height) : { width: square, height: square };
    return { ...cell, state: "ready", display, height: CAPTION + 2 * CELL_PAD + display.height };
  }

  imageCells(row, layout) {
    const box = this.imageBox(row, layout), preview = row.preview;
    const sides = [["Before", preview?.before], ["After", preview?.after]];
    const single = layout === "unified" && row.change !== "modified";
    const shown = single ? sides.filter(([label]) => label === (row.change === "added" ? "After" : "Before")) : sides;
    return shown.map(([label, side]) => this.imageCell(label, side, row, box));
  }

  imageHeight(row, layout) {
    const heights = this.imageCells(row, layout).map((cell) => cell.height);
    return this.isStacked(row, layout) ? heights.reduce((sum, h) => sum + h, 0) : Math.max(...heights);
  }

  imageMessage(cell, row) {
    if (cell.state === "loading") return "Loading image…";
    if (cell.state === "limit") return `Only the first ${MAX_IMAGES} images are shown`;
    if (cell.state === "error") return cell.side.error;
    if (cell.label === "Before" && row.change === "added") return "Added: no image before";
    if (cell.label === "After" && row.change === "deleted") return "Deleted: no image after";
    return "Image not available here";
  }

  imageCaption(cell) {
    const { size, bytes } = cell.side ?? {};
    return [size ? `${size.width} × ${size.height}` : null, bytes ? formatBytes(bytes) : null].filter(Boolean).join(" · ");
  }

  imageCellView(cell, row, t, layout) {
    const color = cell.label === "Before" ? t.ansi1 : t.ansi2;
    const caption = h_flex().h(CAPTION).flex_none().gap(8).items_center()
      .child(div().px(6).h(18).flex().items_center().rounded(4).bg(color + "22").text_size(11).text_color(color).child(cell.label))
      .child(div().text_size(11).text_color(t.dim).child(this.imageCaption(cell)));
    const picture = cell.state === "ready"
      ? div().flex_none().w(cell.display.width).h(cell.display.height).bg(t.raised).child(image(cell.side.src).w(cell.display.width).h(cell.display.height))
      : div().text_color(cell.state === "error" ? t.ansi1 : t.dim).child(this.imageMessage(cell, row));
    return v_flex().flex_1().min_w(0).h(cell.height).p(CELL_PAD).when(layout === "split", (e) => e.items_center()).child(caption).child(picture);
  }

  imageRow(row, t, layout) {
    const cells = this.imageCells(row, layout);
    const frame = this.isStacked(row, layout) ? v_flex() : h_flex();
    return frame.when(layout === "unified" && this.bodyWidth > 0, (e) => e.w(this.bodyWidth)).when(layout === "split" || !this.bodyWidth, (e) => e.w_full())
      .h(this.imageHeight(row, layout)).flex_none().border_b(1).border_color(t.border)
      .children(cells.map((cell, i) => this.imageCellView(cell, row, t, layout).when(layout === "split" && i > 0, (e) => e.border_l(1).border_color(t.border))));
  }

  cardWidth() { return Math.max(MIN_CARD, (this.bodyWidth || 600) - THREAD_INDENT - THREAD_MARGIN); }

  cardColumns(session) { return Math.floor((this.cardWidth() - 2 * CARD_BORDER - CARD_PAD - this.cardPadRight(session)) / CHAR_WIDTH); }

  cardPadRight(session) { return session ? CLOSE_STRIP : CARD_PAD; }

  blocksOf({ comment, orphan }) {
    return C.threadBlocks(comment, {
      asking: this.asking.has(comment.id), failure: this.failures.get(comment.id), orphan,
      replying: this.target?.id === comment.id, session: C.sessionTerminal(comment),
    });
  }

  threadHeight(entry) {
    const blocks = this.blocksOf(entry), columns = this.cardColumns(C.sessionTerminal(entry.comment));
    return CARD_FRAME + blocks.reduce((sum, b) => sum + C.blockLines(b, columns) * LINE, 0) + BLOCK_GAP * (blocks.length - 1);
  }

  cardRow(height, card, padRight = CARD_PAD) {
    return div().w_full().h(height).flex_none().py(ROW_PAD_Y).pl(THREAD_INDENT).font_family(mono()).text_size(12)
      .child(card.w(this.cardWidth()).h_full().pl(CARD_PAD).pr(padRight).py(CARD_PAD_Y).gap(BLOCK_GAP).rounded(6).border_1());
  }

  threadRow(entry, t) {
    const session = C.sessionTerminal(entry.comment), columns = this.cardColumns(session);
    const tones = { you: t.foreground, claude: t.foreground, dim: t.dim, error: t.ansi1 };
    const toneOf = (tone) => tones[tone] ?? t.foreground;
    const text = (b) => (b.spinner
      ? h_flex().h(LINE).gap(6).items_center().text_color(toneOf(b.tone))
        .child(div().w(12).flex_none().text_color(t.accent).frames(SPINNER, SPINNER_MS)).child(b.text)
      : b.reply
        ? div().h(LINE).px(6).flex().items_center().rounded(4).border_1().border_color(t.border).bg(t.background).cursor_text()
          .text_size(11).text_color(t.dim).child(b.text)
        : div().line_height(`${LINE}px`).text_color(toneOf(b.tone)).when(Boolean(b.single), (e) => e.truncate()).child(b.text));
    const blocks = this.blocksOf(entry).map((b) => v_flex().flex_none().h(C.blockLines(b, columns) * LINE).overflow_hidden()
      .when(Boolean(b.label), (e) => e.child(div().h(LINE).flex_none().text_size(11).font_semibold().text_color(b.label !== "You" ? t.accent : t.muted).child(b.label)))
      .child(text(b)));
    const card = v_flex().relative().border_color(t.border).bg(t.raised).children(blocks)
      .when(Boolean(session), (e) => e.child(this.closeSessionStrip(entry.comment, session, t)));
    return this.cardRow(this.threadHeight(entry), card, this.cardPadRight(session));
  }

  /** The card's right edge strip with an x at its top; a click anywhere on it closes the session, as `clickThread` hit-tests by x only. */
  closeSessionStrip(comment, session, t) {
    return v_flex().id(`gc-close-session-${comment.id}`).absolute().top(0).bottom(0).right(0).w(CLOSE_STRIP).pt(CARD_PAD_Y + 3)
      .items_center().rounded_r(5).cursor_pointer().text_color(t.muted).tooltip(`Close session ${session.name}. A reply opens it again.`)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(svg(icon("x")).size(12));
  }

  composeRow(t) {
    const provider = this.composerProvider();
    const hint = C.isClaude(provider.key)
      ? "↩ ask a copy of your Claude Code session · ⇧↩ new line · Esc cancel"
      : `↩ ask ${provider.name} · ⇧↩ new line · Esc cancel`;
    return this.cardRow(COMPOSE_HEIGHT, v_flex().border_color(t.accent).bg(t.background)
      .child(Textarea.new(this.composer).w_full().h(COMPOSE_INPUT).text_size(12).text_color(t.foreground).font_family(mono()))
      .child(div().h(LINE).flex_none().truncate().text_size(11).text_color(t.dim).child(hint)));
  }

  rowView(row, t, layout, key) {
    if (row.kind === "thread") return this.threadRow(row, t);
    if (row.kind === "compose") return this.composeRow(t);
    if (row.kind === "img") return this.imageRow(row, t, layout);
    return layout === "split" ? this.splitRow(row, t, key) : this.unifiedRow(row, t, key);
  }

  rowHeight(row, layout) {
    if (row.kind === "thread") return this.threadHeight(row);
    if (row.kind === "compose") return COMPOSE_HEIGHT;
    if (row.kind === "img") return this.imageHeight(row, layout);
    return row.kind === "f" ? HEAD : ROW;
  }

  heightsFor(rows, layout) {
    if (this.heights?.rows === rows && this.heights.version === this.imageVersion) return this.heights.list;
    const list = rows.map((r) => this.rowHeight(r, layout));
    this.heights = { rows, list, version: this.imageVersion };
    return list;
  }

  /** The shown rows with each line's threads under it, the composer where it's open, and threads whose line is gone at the end. */
  displayRows(base) {
    if (this.display?.base === base && this.display.version === this.threadVersion) return this.display;
    const { placed, orphans } = C.placeComments(this.rows.filter(C.isLine), this.comments);
    const target = this.target, rows = [], keys = [];
    const add = (row, key) => { rows.push(row); keys.push(key); };
    const addThread = (comment, orphan) => {
      add({ kind: "thread", comment, orphan }, `t${comment.id}`);
      if (target?.id === comment.id) add({ kind: "compose" }, "compose");
    };
    base.forEach((row, i) => {
      add(row, `r${i}`);
      const lines = C.linesOf(row);
      for (const line of lines) for (const comment of placed.get(line) ?? []) addThread(comment, false);
      if (target?.anchor && lines.some((line) => C.isAnchor(line, target.anchor))) add({ kind: "compose" }, "compose");
    });
    for (const comment of orphans) addThread(comment, true);
    this.display = { base, version: this.threadVersion, rows, keys, placed };
    return this.display;
  }

  measured(size, cx) {
    const zoom = settings().zoom ?? 1, width = Math.round(size.width / zoom), height = Math.round(size.height / zoom);
    if (width === this.bodyWidth && height === this.bodyHeight) return;
    this.bodyWidth = width; this.bodyHeight = height; this.imageVersion++;
    if (this.imageRows.length || this.comments.length || this.target || this.previewing) cx.notify();
  }

  requestDiagram(source, dark, key, cx) {
    this.diagrams.set(key, null);
    cx.spawn(async (cx) => {
      const drawn = await drawDiagram(source, dark);
      if (this.diagrams.has(key)) { this.diagrams.set(key, drawn); cx.notify(); }
    });
  }

  diagramView(source, id, { t, width, cx }) {
    const dark = isDarkColor(t.background), key = diagramKey(source, dark);
    if (!this.diagrams.has(key)) this.requestDiagram(source, dark, key, cx);
    const drawn = this.diagrams.get(key);
    if (!drawn) return div().text_color(t.dim).child("Drawing diagram…");
    if (drawn.error) return v_flex().gap(4)
      .child(div().text_color(t.ansi1).child(drawn.error))
      .child(TextView.markdown(id, `\`\`\`mermaid\n${source}\n\`\`\``).selectable().w_full());
    const box = fitSize(drawn.size, Math.max(MIN_DIAGRAM, width), MAX_DIAGRAM_HEIGHT);
    return div().flex_none().w(box.width).h(box.height).child(image(drawn.src).w(box.width).h(box.height));
  }

  markdownPart(part, id, context) {
    if (part.kind === Part.Mermaid) return this.diagramView(part.source, id, context);
    return TextView.markdown(id, part.text).selectable().w_full();
  }

  markdownColumn(text, side, context) {
    const column = v_flex().flex_1().min_w(0).h_full(), id = `${this.listId}-md-${side}`;
    if (text === null) return column.p(MARKDOWN_PAD).text_color(context.t.dim).child(this.markdown ? "Not in this version" : "Loading preview…");
    const parts = splitMermaid(text);
    if (!parts.some((part) => part.kind === Part.Mermaid)) return column.child(TextView.markdown(id, text).selectable().scrollable().size_full().p(MARKDOWN_PAD));
    return column.child(v_flex().id(id).size_full().p(MARKDOWN_PAD).gap(MARKDOWN_GAP).overflow_y_scrollbar()
      .children(parts.map((part, i) => this.markdownPart(part, `${id}-${i}`, context))));
  }

  /** The file rendered as Markdown, its Mermaid diagrams drawn: its new version in one column, before | after in two; a deleted file shows its old version. */
  markdownBody(t, layout, cx) {
    const { before, after } = this.markdown ?? { before: null, after: null };
    const columns = layout === "split" ? [["before", before], ["after", after]] : [[after === null ? "before" : "after", after ?? before]];
    const width = Math.floor((this.bodyWidth || 600) / columns.length) - 2 * MARKDOWN_PAD;
    return h_flex().id(`${this.listId}-preview`).flex_1().min_h(0).on_size_change((size, cx) => this.measured(size, cx))
      .children(columns.map(([side, text], i) =>
        this.markdownColumn(text, side, { t, width, cx }).when(i > 0, (e) => e.border_l(1).border_color(t.border))));
  }

  diffBody(t, layout) {
    if (layout === "split" && !this.pairs) this.pairs = G.splitRows(this.rows);
    const { rows, keys } = this.displayRows(layout === "split" ? this.pairs : this.rows);
    const heights = this.heightsFor(rows, layout);
    const list = v_virtual_list(`${this.listId}-${layout}`, rows.length, heights, (i) => keys[i],
      (range) => rows.slice(range.start, range.end).map((row, i) => this.rowView(row, t, layout, keys[range.start + i]))).size_full()
      .on_item_click((key, cx) => this.clickRow(key, cx))
      .on_item_secondary_click((key, _e, cx) => this.threadMenu(key, cx));
    const pressable = div().id(`${this.listId}-rows`).size_full().on_mouse_down("left", (ev) => this.pressed(ev)).child(list);
    return div().id(`${this.listId}-body`).flex_1().min_h(0).relative().font_family(mono()).text_size(12)
      .on_size_change((size, cx) => this.measured(size, cx))
      .when(layout === "unified", (e) => e.child(div().id(`${this.listId}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.width + 110 + MARK + TEXT_PAD).h_full().child(pressable))))
      // Split: one list for both columns keeps them level; sideways scrolling moves both texts.
      .when(layout === "split", (e) => e.child(div().id(`${this.listId}-split`).size_full()
        .on_mouse_down("left", (ev) => { this.pressSide = ev.local_position && ev.bounds && ev.local_position.x < ev.bounds.width / 2 ? "left" : "right"; })
        .on_scroll_wheel((ev, cx) => {
          const dx = ev.delta.x || (ev.modifiers?.shift ? ev.delta.y : 0);
          if (!dx) return;
          this.offset = Math.max(0, Math.min(Math.max(0, this.width - 200), this.offset - dx));
          cx.stop_propagation(); cx.notify();
        })
        .child(pressable)))
      .child(Scrollbar.vertical(`${this.listId}-${layout}`).viewport_from_layout().absolute().inset_0());
  }

  render(cx) {
    this.sync(cx);
    this.takePick(cx);
    const t = theme(), layout = getLayout();
    const root = v_flex().id("git-changes-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key !== "escape" || !this.target) return;
        this.closeComposer(); cx.stop_propagation(); cx.notify();
      });
    if (!this.item) return root.child(div().p(16).text_color(t.dim).child("Pick a file in Changes to see its diff here."));
    const previewing = this.previewing && isMarkdownFile(this.item);
    return root.child(this.header(t, layout))
      .when(layout === "split", (e) => e.child(h_flex().h(22).flex_none().items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().flex_1().px(12).child("Before")).child(div().flex_1().px(12).border_l(1).border_color(t.border).child("After"))))
      .when(Boolean(this.error), (e) => e.child(div().px(12).py(8).text_color(t.ansi1).child(this.error)))
      .child(previewing ? this.markdownBody(t, layout, cx) : this.diffBody(t, layout));
  }
}

// What this space's diff tab shows, if it's open (or opening) on this repository.
export function shownIn(spaceId, root) {
  const e = (shared("git-changes.view") ?? {})[spaceId];
  if (!e || e.source.root !== root) return null;
  return liveTab(spaceId, e.tab) || (e.opening && Date.now() - e.opening < 1500) ? e.item : null;
}

// The repository a space's diff tab shows: a mod pane has no folder of its own.
export function shownSource(spaceId) {
  return (shared("git-changes.view") ?? {})[spaceId]?.source ?? null;
}
