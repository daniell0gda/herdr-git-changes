// Full detail view for a GitHub/GitLab PR, MR, or Issue in Herdr's main area.
// Follows the same shared-state single-tab-per-space pattern as diff.js.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, theme, props, shared, setShared, spaces, panes, run, notify, window as appWindow } from "herdr";
import * as F from "./forge.js";
import { icon } from "./menu.js";

const VIEW_KEY = "git-changes.forgeView";

function liveTab(spaceId, id) {
  return id && spaces().find((s) => s.id === spaceId)?.tabs.some((t) => t.id === id) ? id : null;
}

export function forgeTabName(item, forge) {
  if (item.kind === "ci") return `CI: ${item.name || "Job"}`;
  const prefix = item.kind === "review" ? (forge?.singular === "MR" ? "!" : "#") : "#";
  const tag = item.kind === "review" ? (forge?.singular || "PR") : "Issue";
  return `${tag} ${prefix}${item.number}`;
}

export function showForgeInTab(spaceId, item, source) {
  const views = shared(VIEW_KEY) ?? {};
  const old = views[spaceId], tab = liveTab(spaceId, old?.tab);
  const opening = !tab && old?.opening && Date.now() - old.opening < 1500;
  const live = new Set(spaces().map((sp) => sp.id));
  const kept = Object.fromEntries(Object.entries(views).filter(([id]) => live.has(id)));
  const name = forgeTabName(item, source.forge);
  setShared(VIEW_KEY, { ...kept, [spaceId]: { item, source, at: Date.now(), tab, opening: tab ? null : opening ? old.opening : Date.now() } });
  if (tab) { run("tab.rename", { id: tab, name }); run("tab.select", { id: tab }); }
  else if (!opening) run("tab.new", { space: spaceId, name, mod: "git-changes", props: { role: "forge", space: spaceId } });
}

/** Opens an http(s) link in the browser; any other link, such as a CI check's own scheme, is ignored. */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url ?? ""))) return;
  const cmd = appWindow().platform === "macos" ? "open" : "xdg-open";
  exec(cmd, [url]).catch(() => null);
}

const stateTone = (state, t) => {
  const s = String(state || "").toLowerCase();
  if (["open", "opened", "pass", "approved"].includes(s)) return t.ansi2;
  if (["fail", "changes_requested", "closed"].includes(s)) return t.ansi1;
  if (["merged"].includes(s)) return t.ansi5 ?? t.accent;
  if (["running", "draft", "commented"].includes(s)) return t.ansi3 ?? t.accent;
  return t.muted;
};

const shortDate = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "");

export class ForgeView {
  init(cx) {
    this.space = props().space;
    this.uid = `gcf-${Math.random().toString(36).slice(2)}`;
    this.subtab = "overview";
    this.detail = null;
    this.error = null;
    this.loading = false;
    this.posting = false;
    this.commentBox = TextareaState.new({ placeholder: "Write a comment…", rows: 3 });
    this.commentBox.on("submit", (e, cx) => { if (e.secondary) this.submitComment(cx); });
    this.sync(cx);
  }

  entry() { return (shared(VIEW_KEY) ?? {})[this.space]; }

  claim() {
    const e = this.entry();
    if (!e || e.tab) return;
    const space = spaces().find((s) => s.id === this.space);
    if (!space) return;
    const tabMap = new Map(space.tabs.map((t) => [t.id, t]));
    const mine = panes().filter((p) => p.mod === "git-changes" && tabMap.has(p.tab));
    const tab = (mine.find((p) => tabMap.get(p.tab).active) ?? mine[0])?.tab;
    if (tab) setShared(VIEW_KEY, { ...(shared(VIEW_KEY) ?? {}), [this.space]: { ...e, tab, opening: null } });
  }

  sync(cx) {
    const e = this.entry();
    const id = e ? `${e.at}` : null;
    if (id === this.seen) return;
    this.seen = id;
    if (!e) { this.item = null; this.detail = null; return; }
    if (!e.tab) cx.spawn(async () => this.claim());
    this.item = e.item;
    this.source = e.source;
    this.subtab = "overview";
    this.detail = null;
    this.error = null;
    this.reload(cx);
  }

  reload(cx) {
    if (!this.item || !this.source?.forge) return;
    const seen = this.seen, item = this.item, { root, on, forge } = this.source;
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const opts = { cwd: root, on };
        const detail = item.kind === "ci"
          ? { ...item, log: await F.loadJobLog(exec, forge, item, opts) }
          : item.kind === "review"
            ? await F.loadReviewDetail(exec, forge, item.number, opts)
            : await F.loadIssueDetail(exec, forge, item.number, opts);
        if (seen !== this.seen) return;
        this.detail = detail;
      } catch (e) {
        if (seen === this.seen) this.error = String(e?.message ?? e);
      } finally {
        if (seen === this.seen) { this.loading = false; cx.notify(); }
      }
    });
  }

  pill(text, color, t) {
    return div().px(7).py(1).rounded(99).bg(color + "22").text_size(11).font_semibold().text_color(color).child(text);
  }

  metaRow(label, values, t) {
    if (!values.length) return null;
    return h_flex().gap(6).items_center().flex_wrap()
      .child(div().text_size(11.5).text_color(t.dim).child(`${label}:`))
      .children(values.map((v) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(v.color ?? t.foreground).child(v.text)));
  }

  header(t) {
    const d = this.detail ?? this.item, forge = this.source?.forge;
    const prefix = d.kind === "review" && forge?.singular === "MR" ? "!" : "#";
    const heading = d.kind === "ci" ? (d.name || "CI Job") : `${prefix}${d.number} ${d.title || ""}`;
    const subBtn = (id, label) => div().id(`gc-forge-tab-${id}`).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .text_color(this.subtab === id ? t.foreground : t.muted)
      .when(this.subtab === id, (e) => e.bg(t.selected))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.subtab = id; cx.notify(); })
      .child(label);
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(40).px(12).gap(8).items_center()
        .child(this.pill(d.state || "open", stateTone(d.state, t), t))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(heading))
        .when(d.kind === "review" && Boolean(this.detail?.files?.length), (e) => e.child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(subBtn("overview", "Overview"))
          .child(subBtn("files", `Files (${this.detail.files.length})`))))
        .when(Boolean(d.url), (e) => e.child(h_flex().id("gc-forge-open").h(24).px(8).items_center().rounded(5).cursor_pointer().text_size(11.5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open in browser")
          .on_click(() => openExternal(d.url)).child("Open ↗")))
        .child(h_flex().id("gc-forge-refresh").size(24).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).tooltip("Refresh")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.reload(cx); cx.notify(); })
          .child(svg(icon("refresh")).size(13)))
        .child(h_flex().id("gc-forge-close").size(24).items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).tooltip("Close")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { const tab = this.entry()?.tab; if (tab) run("tab.close", { id: tab }); })
          .child(svg(icon("x")).size(13))))
      .child(h_flex().h(24).px(12).gap(10).items_center().text_size(11).text_color(t.dim)
        .child(div().child(d.author ? `by @${d.author}` : ""))
        .when(Boolean(d.head && d.base), (e) => e.child(div().text_color(t.muted).child(`${d.head} → ${d.base}`)))
        .child(div().flex_1().min_w(0).truncate().text_right().child(this.loading ? "Loading…" : `${forge?.repo ?? ""} ${shortDate(d.updatedAt)}`)));
  }

  checksSection(checks, t) {
    if (!checks?.length) return null;
    const summary = F.summarizeChecks(checks);
    return v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_size(12).child("CI Checks"))
        .child(this.pill(summary.summary, stateTone(summary.state, t), t)))
      .children(checks.map((c, i) => h_flex().id(`${this.uid}-chk-${i}`).gap(8).items_center().text_size(12)
        .when(Boolean(c.url), (e) => e.cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => openExternal(c.url)))
        .child(div().w(14).text_color(stateTone(c.state, t)).child(c.state === "pass" ? "✓" : c.state === "fail" ? "✗" : c.state === "running" ? "●" : "·"))
        .child(div().flex_1().min_w(0).truncate().child(c.name))
        .child(div().text_size(11).text_color(t.dim).child(c.state))));
  }

  commentsSection(comments, t) {
    if (!comments?.length) return div().text_size(12).text_color(t.dim).child("No comments yet.");
    return v_flex().gap(8)
      .child(div().font_semibold().text_size(12).text_color(t.muted).child(`Comments (${comments.length})`))
      .children(comments.map((c, i) => v_flex().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(h_flex().gap(8).items_center().text_size(11.5)
          .child(div().font_semibold().text_color(t.accent).child(c.author ? `@${c.author}` : "comment"))
          .when(Boolean(c.path), (e) => e.child(div().px(6).py(1).rounded(4).bg(t.background).border_1().border_color(t.border).text_size(11).text_color(t.muted)
            .child(c.line ? `${c.path}:${c.line}` : c.path)))
          .child(div().flex_1().text_right().text_size(11).text_color(t.dim).child(shortDate(c.createdAt))))
        .child(TextView.markdown(`${this.uid}-c-${i}`, c.body || "_(empty)_").selectable().w_full())));
  }

  filesSection(files, t) {
    return v_flex().p(12).gap(4)
      .children(files.map((f, i) => h_flex().id(`${this.uid}-f-${i}`).h(26).px(8).gap(8).items_center().rounded(5).border_1().border_color(t.border).bg(t.raised)
        .child(svg(icon("file")).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.path))
        .when(f.additions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.additions}`)))
        .when(f.deletions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`)))));
  }

  submitComment(cx) {
    const body = this.commentBox.value().trim();
    if (!body || this.posting || !this.item || !this.source?.forge) return;
    const { root, on, forge } = this.source, item = this.item;
    this.posting = true;
    cx.spawn(async (cx) => {
      try {
        await F.postComment(exec, forge, item, body, { cwd: root, on });
        this.commentBox.set_value("");
        this.reload(cx);
      } catch (e) {
        notify({ title: "Comment failed", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.posting = false; cx.notify();
      }
    });
    cx.notify();
  }

  commentComposer(t) {
    return v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(div().p(6).rounded(6).border_1().border_color(t.border).bg(t.background)
        .child(Textarea.new(this.commentBox).w_full().h(64).text_size(12).text_color(t.foreground)))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(11).text_color(t.dim).child("⌘↩ to post comment"))
        .child(h_flex().id(`${this.uid}-post`).h(24).px(10).items_center().rounded(6).cursor_pointer().text_size(11.5).font_semibold()
          .bg(t.accent).text_color(t.background).hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.submitComment(cx))
          .child(this.posting ? "Posting…" : "Comment")));
  }

  overviewBody(d, t) {
    const metas = [
      this.metaRow("Assignees", (d.assignees ?? []).map((a) => ({ text: `@${a}` })), t),
      this.metaRow("Reviewers", (d.reviewers ?? []).map((r) => ({ text: `@${r.login}${r.state ? ` (${r.state})` : ""}`, color: stateTone(r.state, t) })), t),
      this.metaRow("Labels", (d.labels ?? []).map((l) => ({ text: l, color: t.accent })), t),
    ].filter(Boolean);
    return v_flex().p(14).gap(12)
      .when(metas.length > 0, (e) => e.child(v_flex().gap(6).children(metas)))
      .child(v_flex().p(12).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(TextView.markdown(`${this.uid}-body`, d.body?.trim() || "_No description provided._").selectable().w_full()))
      .when(Boolean(d.checks?.length), (e) => e.child(this.checksSection(d.checks, t)))
      .child(this.commentsSection(d.comments, t))
      .child(this.commentComposer(t));
  }

  ciBody(d, t) {
    const text = d.log ? `\`\`\`\n${d.log}\n\`\`\`` : (d.summary || "_No log output available here. Click **Open ↗** to inspect in the browser._");
    return v_flex().p(14).gap(12)
      .child(v_flex().p(12).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(TextView.markdown(`${this.uid}-cilog`, text).selectable().w_full()));
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    const root = v_flex().id("git-changes-forge").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5);
    if (!this.item) return root.child(div().p(16).text_color(t.dim).child("Pick a PR/MR or Issue in the panel to inspect it here."));
    return root.child(this.header(t))
      .when(Boolean(this.error), (e) => e.child(div().p(12).text_color(t.ansi1).child(this.error)))
      .when(!this.detail && this.loading, (e) => e.child(div().p(16).text_color(t.dim).child("Loading details…")))
      .when(Boolean(this.detail), (e) => e.child(v_flex().id(`${this.uid}-scroll`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.detail.kind === "ci" ? this.ciBody(this.detail, t) : this.subtab === "files" && this.detail.files?.length ? this.filesSection(this.detail.files, t) : this.overviewBody(this.detail, t))));
  }
}
