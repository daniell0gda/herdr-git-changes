import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { icon } from "./menu.js";

export const HELP_WIDTH = 500, HELP_HEIGHT = 520;

export const HELP_TEXT = `### The view
Shows the changes of the picked file, commit, stash or branch.
- Switch between **one column** and **two columns** (before | after) in the header.
- In a diff of many files, click a file's header to fold it.
- On a hunk header, **↑ 10** shows 10 more unchanged lines above the change and **↓ 10** 10 more below the change before it. The arrow to a line beside each shows all the hidden lines in that direction.

### Find
- **Ctrl+F** opens a find bar. Each match, in any case, gets a yellow background.
- **Enter** goes to the next match and **Shift+Enter** to the one before. The current match has a stronger background.
- In the Markdown preview, the matches are marked but the view doesn't scroll to them.
- **Esc** closes the bar. Ctrl+F opens it again with the same text.

### Comments start a chat session
- **Click a line** to write a comment under it. **Enter** sends, **Shift+Enter** starts a new line, **Esc** closes the box.
- The comment starts a copy of your Claude Code session as a sub-agent, or the agent picked with the comment button in the header. Its answer shows under the line.
- Click a thread to reply. Right-click it to open its session, ask again, copy the answer or delete the thread.
- The **✕** on a thread closes its session and keeps the thread. **Shift-click** it to delete the thread and its session.

### Mark a word
- Hold **Alt**: a click opens no comment box, and lines show no hover or new-comment icon.
- **Alt + double-click** a word: it gets a shaded background, and each other place it appears is underlined.
- **Esc**, or Alt + double-click off a word, clears the mark.`;

export class DiffHelp {
  init() {}

  render() {
    const t = theme();
    return v_flex().id("git-changes-help").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(h_flex().px(16).pt(12).pb(8).gap(10).items_center()
        .child(svg(icon("circle-help")).size(14).flex_none().text_color(t.accent))
        .child(div().flex_1().min_w(0).font_semibold().child("Diff view help"))
        .child(div().id("gch-close").flex_none().p(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => closeOverlay(props().overlay))
          .child(svg(icon("x")).size(14).text_color(t.muted))))
      .child(v_flex().id("gch-text").flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(14)
        .child(TextView.markdown("gch-body", HELP_TEXT).selectable().w_full()));
  }
}
