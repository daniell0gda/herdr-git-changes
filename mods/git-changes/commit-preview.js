// A commit's whole message in a dialog: the subject, the body and the footer
// (its trailers), opened from a commit's right-click menu with props
// { role: "commit", commit } (from git.js' parseCommitMessage).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { parseTrailer } from "./git.js";
import { icon } from "./menu.js";

export const PREVIEW_WIDTH = 560;
const LINE = 18, FRAME = 110, MAX_HEIGHT = 560;

/** Tall enough for the message's lines, up to a limit past which the message scrolls. */
export function previewHeight(commit) {
  const lines = [commit.body, commit.footer].filter(Boolean).join("\n\n").split("\n").length;
  return Math.min(MAX_HEIGHT, FRAME + LINE * lines);
}

const pad = (n) => String(n).padStart(2, "0");
const localTime = (seconds) => {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export class CommitPreview {
  init() {
    this.commit = props().commit;
  }

  header(c, t) {
    return h_flex().px(16).pt(12).pb(8).gap(10).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_none().text_color(t.accent).child(c.short))
      .child(div().flex_1().min_w(0).truncate().child(`${c.author} · ${localTime(c.time)}`))
      .child(div().id("gcc-close").flex_none().p(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => closeOverlay(props().overlay))
        .child(svg(icon("x")).size(14).text_color(t.muted)));
  }

  lines(text, color) {
    return v_flex().text_color(color).children(text.split("\n").map((line) => div().min_h(LINE).child(line)));
  }

  footer(text, t) {
    return v_flex().pt(10).border_t_1().border_color(t.border).children(text.split("\n").map((line) => {
      const trailer = parseTrailer(line);
      if (!trailer) return div().min_h(LINE).child(line);
      return h_flex().min_h(LINE)
        .child(div().flex_none().text_color(t.dim).child(`${trailer.key}${trailer.separator}`))
        .child(div().flex_1().min_w(0).child(trailer.value));
    }));
  }

  render() {
    const t = theme(), c = this.commit;
    return v_flex().id("git-changes-commit").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(this.header(c, t))
      .child(v_flex().id("gcc-message").flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(14).gap(12)
        .child(div().text_size(14).font_semibold().child(c.subject))
        .when(Boolean(c.body), (e) => e.child(this.lines(c.body, t.foreground)))
        .when(Boolean(c.footer), (e) => e.child(this.footer(c.footer, t))));
  }
}
