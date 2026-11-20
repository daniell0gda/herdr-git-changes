# Git Changes for Herdr

A git panel for the [Herdr](https://herdr.dev) desktop app, laid out like
[Zed](https://zed.dev)'s git panel. You stage files with checkboxes, then
commit, amend, stash, pull and push from the panel, and browse the history as a
commit graph. Whatever you click opens its diff in the main area, in one or two
columns. The file list is a folder tree or a flat list. It follows the
repository of the terminal you're focused on.

It's meant to take the place of the Changes panel that ships with Herdr. That
panel lists files and shows diffs; its only action is a single Commit that
stages everything first. Installing doesn't swap them by itself: each layout
picks its own Changes panel, so you point your layouts at this one
([how](#use-it-as-your-changes-panel)).

![Git Changes: a commit picked in History shown in two columns in the main area; beside it the Changes panel as a folder tree, and the History tab with its commit graph](preview.png)

## Features

- **[Changes](#changes-tab):** staged, unstaged, untracked and conflicted
  files, as a folder tree or a flat list, with a checkbox to stage each file,
  folder or group. Discard a file, or trash an untracked one. Stage all,
  unstage all, discard or trash everything from one menu.
- **Filter files:** a box that keeps only the files whose path matches, in
  the Changes and Repo tabs.
- **[Repo](#repo-tab):** every file your branch changed since it left its
  base branch (`main`, `develop`, `release/…`), as a merge request shows it.
- **[Diff in the main area](#the-diff-in-the-main-area):** one column or two
  (before | after), syntax colors for TypeScript, JavaScript, C# and HTML, and
  images shown as pictures, before and after.
- **[Markdown preview](#the-diff-in-the-main-area):** a Changes | Preview
  switch on a Markdown file's diff shows the file rendered, the new version or
  before | after.
- **[Mermaid diagrams](#the-diff-in-the-main-area):** ` ```mermaid ` blocks in
  the preview show as pictures, drawn by the Mermaid CLI in the theme's light
  or dark look.
- **[Comments on a line](#comments-on-a-line-answered-by-claude-code):** a
  copy of your Claude Code session answers under the line, and you can reply.
- **[Commit](#commit-area):** commit, commit tracked (`-a`), amend, signoff,
  commit & push, uncommit, and a suggested message for a single file.
- **[Remote](#commit-area):** one button that pulls, pushes, publishes or
  fetches, whichever fits, plus pull (rebase) and force push with lease.
- **Branches:** switch to a local branch from the branch row, or check out a
  branch, a remote branch or a commit from History.
- **Stashes:** stash all or only what's staged; apply, pop, drop and show the
  diff of each stash.
- **[History](#history-tab):** a commit graph with lanes, branch and tag
  labels, all branches or the current one, revert and copy hash.
- **On a file or folder:** open with an application of its type (Linux),
  open the folder in your file manager or a terminal tab, copy the path.
- **Keyboard:** ↑ ↓ move through every list, ← → fold, ↩ opens, ⌘↩ commits.
- **[Safe](#safety):** destructive actions ask once more in place.
- **Fast:** only the rows on screen are drawn, and it follows the repository
  of the focused terminal, also on other machines.

## What it does

### Changes tab

- **Files grouped like Zed's:** Conflicts, Tracked, Untracked, then your
  Stashes. Each file has a checkbox that stages it, unstages it, or shows `−`
  when only part of it is staged. Each group header has a checkbox for the
  whole group.
- **Tree or flat**, from the toolbar's first pair of icons:
  - **Tree** nests files under their folders, folders first. A folder that
    only holds one folder is merged into it (`src/ui`). Click a folder to fold
    it; its checkbox stages or unstages everything inside. Folding is
    remembered per group.
  - **Flat** lists every file, with its folder in grey beside the name.
- **Toolbar:**
  - View Diff shows every change at once in the main area.
  - Tree / Flat, then One column / Two columns (the same switch as the diff
    tab's own).
  - The ☰ menu: Stage all, Unstage all, stash everything, stash only what's
    staged, pop the latest stash, discard tracked changes, trash untracked
    files.
  - Stage All / Unstage All.
- **Filter files**, the box under the toolbar: shows only the files whose path
  holds what you type, ignoring case. The groups count only those files, and a
  group's or folder's checkbox stages only them; Stage All still stages
  everything. ↓ and ↑ move from the box into the list, Esc or the ✕ empties
  it. The same filter applies in the Repo tab.
- **On a file:** click it to show its diff in the main area. The button at the
  end of the row discards it (it turns red on hover and asks once more).
  Right-click to stage, show the diff, **open it with** an application, **open
  its folder**, copy its path, or discard it.
- **On a folder (Tree):** click to fold it. Right-click to stage or unstage
  everything in it, **open the folder**, or copy its path.
- **Open folder** shows the folder in your file manager (`xdg-open` on Linux,
  `open` on macOS, `explorer` on Windows). **Open in terminal** starts a
  terminal tab in it. The path is inside the focused terminal's repository, and
  a file in the repository's root opens the root. For a space on another
  machine, only the terminal tab is offered.
- **Open with…** lists the applications that open the file's type, the default
  one first, and opens the file with the one you pick. On Hyprland the window
  opens floating. An application that is already open, such as VS Code, can
  take the file into its open window, which stays as it is. It is on file rows of
  the Changes and Repo tabs, on Linux and on this computer only, and it is off
  for a deleted file.
- **On a stash:** click to see its diff, new files included. The buttons at the
  end of the row Apply, Pop or Drop it.
- **Arrow keys** (click the list first): ↓ and ↑ select the row below and
  above. A file or a stash opens its diff at once; a group or a folder only
  lights up. ← folds the selected group or folder, → unfolds it, ↩ toggles it.
  The list scrolls to keep the row on screen. The keys do nothing while you
  type in the message box.
- **Big lists stay quick.** Only the rows on screen are drawn, so a worktree
  with hundreds of changed files scrolls and hovers as smoothly as one with
  three. A refresh that finds nothing new redraws nothing.

### Repo tab

Every file your branch's commits changed since it left its base, as a merge
request shows it. Staged, unstaged and untracked work stays in Changes.

- **The base** is the branch your branch most likely started from, as a
  merge request's target: of `main`, `master`, `develop`, every `release/…`
  (local and on origin) and origin's default branch, the one that lacks the
  fewest of your commits. A branch made from `release/86005.x` compares with
  it, even when `main` or the default branch is far ahead. Files are compared
  with the merge base of that branch and HEAD, so work that landed on the base
  after you branched off doesn't show. A rename counts as a delete and an add. On `main` itself, it shows
  the files of your commits that `origin/main` doesn't have yet.
- **Tree or flat**, the same switch as in Changes. Click a folder to fold it;
  folding is remembered apart from Changes.
- **Click a file** to see what the commits changed in it (merge base to
  HEAD) in the main area.
  View Diff shows all of them at once. Right-click a file or a folder to open
  its folder or copy its path. The arrow keys and the file filter work as in
  Changes.
- The toolbar shows the lines added and removed, and how many files changed
  since which base.
- No checkboxes and no discard here: stage and discard in Changes.
- Read only while the tab shows, like History.

### The diff, in the main area

Clicking a file, a stash, a commit or View Diff opens a tab in the main area,
next to your terminals, named after what it shows (`app.ts`, `stash@{0}`, a
short hash). Each space has one such tab: the next click reuses and renames
it, and closing it (its × or your `tab.close` key, ⌘W) just closes it until
the next click.

- **One column:** old and new line numbers side by side, `−` lines in red and
  `+` lines in green.
- **Two columns:** *Before* on the left, *After* on the right, on one shared
  vertical scroll. Removed and added lines next to each other pair up by
  position, never across a hunk or an unchanged line; a side with nothing
  opposite stays empty. Scroll sideways (trackpad or Shift+wheel) and both
  sides move together.
- The switch is in the tab's header and in the panel's toolbar; both change
  every diff tab.
- **Syntax colors** for TypeScript and JavaScript, C# and HTML, from the
  terminal theme's colors: keywords, types, calls, strings, numbers and
  comments, or tags, attributes and their values. Changed lines keep their red
  or green background and sign. Other files keep the plain red and green text.
- **Images** (PNG, JPEG, GIF, WebP, SVG and BMP) show as pictures, with their
  size and file size. A changed image shows *Before* and *After*: stacked in
  one column, side by side in two columns, so the same switch compares them.
  An added or untracked image shows the new picture, a deleted one the old
  picture. A commit, a stash or View Diff that touches images shows them inline,
  next to the text of the other files. An SVG also shows its text diff. Pictures
  are scaled down to fit, never up.
- **Markdown preview:** a Markdown file (`.md`, `.markdown`) gets a second
  switch in the header, Changes | Preview. Preview shows the file rendered: its
  new version in one column, *Before* and *After* side by side in two columns.
  A deleted file shows its old version. The choice stays for the next file the
  tab shows.
- **Mermaid diagrams** in a Markdown file (a ` ```mermaid ` or `~~~mermaid`
  block) show as pictures in the preview, drawn by the
  [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) in the terminal
  theme's light or dark look. A diagram with an error shows the error and its
  source. Without the CLI, each diagram shows its source and how to install it:
  `npm install -g @mermaid-js/mermaid-cli`.
- The tab follows the files: saving a shown file refreshes it.
- The row the tab shows is highlighted in the panel.

### Comments on a line, answered by Claude Code

- **Click a line** of the diff to write a comment under it. Under the pointer,
  the line numbers of the line light up, as in GitLab, with a new-comment icon
  at their start; a line with a thread keeps a speech-bubble icon in the
  accent colour. Enter sends, Shift+Enter starts a new
  line, Esc closes the box. In two columns, click the side you mean.
- **A copy of your Claude Code session answers**, right under your comment.
  The comment starts an interactive fork of the session as its **sub-agent**
  in Herdr (named `review-…`, titled *Review: <file>:<line>*), in the session's
  own folder. So it loads the project's `.claude` settings, has the same
  permissions, and can do the work you ask for. It knows what the session
  knows; the session itself does not change. A spinner shows while it works,
  then its answer (the last text of its turn) appears in the thread. It is
  asked to keep each answer to a sentence or two.
- **Which session is copied:** the newest session of the first of these that
  has one: the Claude Code terminals in the diff's space, the Claude Code
  terminals inside the repository, then the repository and its main checkout
  (a session that made a worktree keeps its sessions where it started). The
  copy runs as a sub-agent of that terminal and outlives it.
- **Reply** in the box at the end of an answered thread (or click anywhere on
  the thread). The reply is typed into the copy's terminal (`hc send`, which
  waits while you are typing there). When that session was closed, the reply
  opens it again.
- **When it needs you** (a permission prompt), the thread says *Waiting for
  you in its session*. **Right-click → Open session** shows its terminal.
- **Right-click a thread** to open its session, reply, ask again after a
  failure, copy the answer, or delete the thread. Deleting ends the session and
  deletes its files, so it doesn't stay in `claude --resume`.
- **Local only.** Comments are saved in the repository's git folder
  (`.git/git-changes-comments.json`), never in the worktree, GitHub or GitLab.
  A comment follows its line by the line's text, so it stays in place when
  lines above it change. When its line is gone from the diff, the thread moves
  to the end of the diff and quotes the line.

### Commit area

- **The branch row** shows `repo / branch ⌄`. Click it to switch to another
  local branch.
- **The remote button** picks what makes sense now: `↓N Pull` when you're
  behind, `↑N Push` when you're ahead, Publish for a branch with no upstream,
  else Fetch. Its ⌄ menu has Fetch, Pull, Pull (rebase), Push and
  Force push (with lease).
- **The message box** is multi-line. ⌘↩ commits. With one changed file it
  suggests a message, as Zed does (`Update store.ts`).
- **Generate a message (✨):** asks a coding agent's CLI to write the message
  from the staged diff (every tracked change when nothing is staged) and puts
  it in the box. It never commits, and it doesn't overwrite a message you've
  typed. The sliders button next to it picks the agent (Claude Code, Hermes or
  Codex), the model and the effort; the choice is remembered. It runs a fresh
  one-shot command (`claude -p`, `hermes -z`, `codex exec`) with the diff,
  cut to 12,000 characters, and your last five commit subjects in the prompt.
  The agent's CLI must be installed on the repository's machine.
- **Commit or Commit Tracked:** the button commits what's staged. When nothing
  is staged it reads *Commit Tracked* and runs `git commit -a`. Its ⌄ menu has
  Amend (pre-filled with the last message), Signoff, Commit & push, Stash all
  and Uncommit.
- **The last commit** sits at the bottom with its short hash (click to copy the
  full one), ↶ Uncommit (the changes stay staged) and a jump to History.

### History tab

A commit graph drawn the way [herdr-git-graph](#credits) draws it:

- Colored lanes, with curves where branches fork and merge.
- Labels for branches (✓ on the checked-out one, a cloud when it's pushed),
  remote branches and tags.
- HEAD drawn as a ring, and your uncommitted changes as a dashed top row.

Controls:

- **All branches / Current** in the toolbar.
- **☁** shows every remote branch. Off by default: only your branch's upstream
  shows, because remote branches you don't work on each take a lane.
- **The graph's width** is capped at about a quarter of the panel. When the
  panel is narrow the lanes move closer together, down to 6px apart; past that
  the outer ones are cut off. A row shows one label and folds the rest into
  `+N`.
- **Clicking a commit** shows its diff in the main area; the uncommitted row
  shows every change. ⌘C copies the shown commit's hash. ↓ and ↑ open the
  commit below and above.
- **Right-click a commit** to check out a branch on it, a remote branch
  (tracking it) or the commit itself, show its diff, copy its hash, short hash
  or message, revert it, or uncommit it if it's the last one.
- **Paging:** 300 commits at first, 300 more each time you scroll to the end.

### Safety

Discard, Drop, Trash and Force push are destructive. They ask once more in
place: the button turns into *Sure?*, or the menu item into *Click again*.
Nothing else asks. When git refuses, its own message appears under the list.
Push, pull and fetch failures also show as a notification.

## What it runs

The mod runs `git` in the focused terminal's repository. For a space on another
machine, it runs git on that machine. It also reads files there to preview an
untracked file or a Markdown file. Every git call is an argument list, never a shell line. Reads
use `--no-optional-locks` and leave the index alone, so the panel's own refreshes
don't wake its file watcher.

It reaches the network only through git, when you Fetch, Pull or Push. Outside
the repository it does three things:

- To show an image, it copies the image's bytes (a git object, or the file on
  disk) into `~/.config/herdr-app/data/git-changes/preview/`, named by content,
  because Herdr loads pictures only from its own folder. It runs a fixed
  `sh -c` script for the copy (`git cat-file` or `cp`, then `mv`) with the paths
  as separate arguments, and `wc` to check the size. The folder is emptied when
  it holds more than 300 files. It works on this computer only.
- To draw a Mermaid diagram, it writes the diagram's text to the same folder
  and runs `mmdc` on it (the Mermaid CLI, which starts a headless Chromium). The
  PNG stays there, named by content; the text file is removed. It runs on this
  computer, also for a space on another machine.
- *Open folder* starts `xdg-open`, `open` or `explorer` on the folder.
- *Open in terminal* runs Herdr's `tab.new` for the folder.
- *Open with…* runs `gio info` and `gio mime` for the file's type, reads the
  applications' names from their `.desktop` files, and starts the one picked
  with `gio launch`. On Hyprland it starts `gio launch` through `hyprctl
  dispatch` with a `float` rule, so the window opens floating. An application
  that detaches from its launch (VS Code does) escapes that rule, so for 10
  seconds it reads `hyprctl -j clients` and floats the application's first new
  window, matched by `StartupWMClass` when the `.desktop` file names one.
- A comment on a line starts `claude --resume <session> --fork-session
  --session-id <id> -- <comment>` with `hc run --bg`, as a sub-agent of the
  session's terminal, and types replies into it with `hc send`. To find the
  session to fork, it runs a fixed `sh -c` script that lists the newest
  `*.jsonl` files in Claude Code's `projects` folder (`$CLAUDE_CONFIG_DIR`,
  else `~/.claude`); it reads answers with `tail` of the copy's own file there.
  Deleting a thread runs `hc kill` on its terminal and `rm` on that thread's
  own session files, and on nothing else. The copy is a full Claude Code
  session: it costs tokens like one and may change files as you ask it to.

## Install

Ask your Herdr agent:

> add the mod at github.com/daniell0gda/herdr-git-changes

It reads [RECIPE.md](RECIPE.md), copies `mods/git-changes/` into
`~/.config/herdr-app/mods/`, and runs `herdr-app check` on it.

By hand:

```sh
git clone https://github.com/daniell0gda/herdr-git-changes
cp -R herdr-git-changes/mods/git-changes ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/git-changes
```

### Use it as your Changes panel

Installing the mod doesn't replace anything by itself. Which mod the Changes
button opens is set **in each layout file**, by the block with
`"id": "changes"`. A layout still pointing at Herdr's `changes` keeps the old
panel, and this one only opens as a separate pane or tab. Do the step below
**for every layout you switch between** (`ctrl-shift-l` cycles them).

To see which mod each of your layouts uses for Changes:

```sh
cd ~/.config/herdr-app/layouts
grep -l '"mod": *"changes"' *.json      # still on Herdr's panel
grep -l '"mod": *"git-changes"' *.json  # already on this one
```

**A layout of your own** (a clone, or one you wrote): edit it in place. Find
the block with `"id": "changes"` inside the `panel-body` stack and point it
at this mod:

```json
{ "id": "changes", "type": "block", "content": { "mod": "git-changes" } }
```

Herdr reloads the layout within a second; there's no need to restart it.

**Herdr's own `main` layout** is read-only: Herdr restores it on every start,
and an edit gets moved aside as `main-edited`. Clone it first, then edit the
clone as above. `layout.clone` switches the window to the clone.

```sh
herdr-app do layout.clone '{"name":"main","as":"my-main"}'
```

A layout cloned later starts with Herdr's panel again, so repeat the edit
there too.

The tab bar's Changes button then opens this panel. A key bound to show the
`changes` child of `panel-body` opens it too.

Keep the `panel` column around `panel-body`. The tab bar shows and hides the
panel through it, and without it every click toasts
`layout.show failed: no node "panel"`.

### Or open it as a pane or a tab

On one repository, whatever is focused:

```sh
herdr-app do pane.split '{"direction":"right","mod":"git-changes","props":{"folder":"/path/to/repo"}}'
herdr-app do tab.new '{"name":"History","mod":"git-changes","props":{"folder":"/path/to/repo","tab":"history"}}'
```

| Prop | Meaning |
|---|---|
| `folder` | Show this repository instead of the focused terminal's. |
| `on` | With `folder`: the machine it's on (a name from `hc machine ls`). |
| `tab` | Open on `"changes"`, `"repo"` or `"history"`. Without it, the panel opens on the tab you used last. |

## Limits

- Tested on macOS with Herdr 0.1.11. The virtual list, the image previews and
  Open folder were added on Linux (Hyprland) with a newer Herdr: the node tests
  cover them and `herdr-app check` loads them, but the pictures and the exact
  click positions have not been confirmed in a running window yet. Windows
  isn't tested.
- Whole files only: no staging of single hunks or lines yet.
- Renames show as a delete and an add (status runs with `--no-renames`).
- At most 1,000 changed files are listed. A diff shows up to 5,000 lines; an
  untracked file shows its first 3,000 lines.
- Mermaid diagrams need `mmdc` on the `PATH` Herdr starts with. The first
  draw of a diagram takes a second or two; diagrams are drawn one at a time.
  After you install `mmdc`, pick the file again.
- Image previews need `sh` and `git` (not Windows without them), skip images over
  10 MB, show the first 20 images of a diff, and don't work for another machine.
  An image Herdr can't decode shows as an empty box.
- Hover highlights a row, but the buttons at its end are always there: Herdr has
  no way yet to show a row's children only while the pointer is on the row.
- Two columns pair lines by position, not by similarity: a block of 3 removed
  and 1 added lines puts the added one next to the first removed one. There's
  no word-level highlighting.
- The diff tab belongs to its space. If you drag it into another space, the
  next click there opens a new one.
- Comments need `claude` and `sh` on the repository's machine. On another
  machine, they work, but they are not saved: they last until the diff tab
  closes. When two Claude Code sessions run in the same folder, the newest one
  is forked. A comment's thread height is estimated from its text, so a very
  long answer can be cut at the bottom of its card.
- No branch creation, merge, rebase, cherry-pick or tags from the panel; use
  [herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph) for those.
- `herdr-app check` renders the panel once, before any git output arrives, so
  it can't catch errors in the rows, and it doesn't load pictures.
  `tests/ui.test.mjs` covers that; test in the app too.

## Development

```sh
node tests/git.test.mjs   # git logic against real repositories
node tests/rows.test.mjs  # the list's rows, where a click lands, image sizes
node tests/syntax.test.mjs # syntax colors: languages and tokens
node tests/ui.test.mjs    # the panel and the diff tab, rendered
```

`git.test.mjs` builds throwaway repositories with a bare "remote". It runs
every command a button or menu item runs against real git, then checks the
parsing, the Repo tab's base and files, the commit modes, the remote button's choice, stashes, uncommit, force
push, checkout and the history graph (lanes, labels, the remote toggle).

`rows.test.mjs` checks the list's rows (tree, flat, folded, staged state), where
a click lands in each kind of row, and reading an image's size from its bytes.

`ui.test.mjs` loads `panel.js` and `diff.js` under node with a small stand-in
for Herdr and GPUI, on a real repository. It draws every row, which
`herdr-app check` doesn't, and refuses a handler inside a virtual list's row as
Herdr does. It clicks through:
- the tree, folding and flat;
- a folder's checkbox, a file's checkbox and its discard button;
- that nothing listens for hover, and that a render's cost doesn't grow with
  the number of files;
- opening the diff tab and reusing it;
- one and two columns;
- Repo: only the files a branch's commits changed, folding, and their diff
  against the merge base;
- History;
- Open folder and Open in terminal;
- Open with, with a stand-in `gio`;
- image diffs: modified, added, deleted, in a commit and in a stash;
- the Markdown preview: one and two columns, an untracked file, a Repo file,
  and no switch on other files;
- Mermaid diagrams, with a stand-in `mmdc`: finding the blocks, the drawn
  picture and its cache, a diagram with an error, and no `mmdc`;
- comment threads, with a stand-in `hc` and session files: the interactive
  fork started as a sub-agent, its answer read back, replies typed into it or
  reopening it, a second thread that skips the copies, waiting for permission
  and Open session, a thread that follows its line, Ask again, a session closed
  without an answer, Delete thread, worktrees, and the side picked in two
  columns.

None needs Herdr. CI runs all of them on every push.

While editing, copy the folder over the installed one and check it:

```sh
rsync -a mods/git-changes/ ~/.config/herdr-app/mods/git-changes/
herdr-app check ~/.config/herdr-app/mods/git-changes
```

Files in `mods/git-changes/`:

| File | What's in it |
|---|---|
| `main.js` | Picks a role from `props.role`: the panel, a menu, or the diff tab (`"diff"`). |
| `panel.js` | The panel: reading the repository, every action, the Changes and Repo tabs' virtual lists, their menus, and the commit area. |
| `rows.js` | The Changes and Repo lists as flat rows, and where a click lands in a row. No Herdr imports. |
| `images.js` | Copies an image's bytes into Herdr's folder so it can be shown. |
| `imageinfo.js` | An image's size from its bytes, scaling it to fit, file sizes. No Herdr imports. |
| `history.js` | The History tab's graph. |
| `lanes.js` | Lays commits out on lanes (from herdr-git-graph, unchanged). |
| `diff.js` | Loading diffs, the one diff tab per space, its one- and two-column views, its image rows, its Markdown preview and its comment threads. |
| `markdown.js` | Reads a Markdown file's text before and after its change, for the preview. |
| `mermaid.js` | Finds the Mermaid blocks in Markdown and draws each with the Mermaid CLI. |
| `comments.js` | Comment threads: pinning a comment to its line, saving them in the git folder, and asking a fork of the Claude Code session. |
| `syntax.js` | Syntax colors: a file's language from its extension, and each diff line split into colored tokens. No Herdr imports. |
| `aimsg.js` | The generated commit message: the agent, model and effort choices, the prompt, each agent's arguments and the cleanup of its reply. No Herdr imports. |
| `menu.js` | The dropdown and right-click menus, shown as popups. |
| `git.js` | Parsing git's output, the folder tree, pairing lines for two columns, finding the images in a diff, and the argv behind every action. No Herdr imports, so node can test it. |

The panel and the diff tab are separate copies of the mod. They talk through
shared state:
- `git-changes.view`: per space, what the diff tab shows, from which
  repository, and the tab's id.
- `git-changes.layout`: one or two columns.

## Credits

This repository continues another one, reuses code from two projects and takes
ideas from two more. Each file that holds borrowed code says so at its top.

**[herdr-git-changes](https://github.com/aBER0724/herdr-git-changes)** by
aBER, MIT License. This is a copy of that repository, carried on here.

- From it: the mod itself, as described below: the Changes tab with its
  staging checkboxes, tree and flat lists, the commit area, stashes, the
  remote button, History, the menus, and the diff tab in one or two columns.
  David Clausen's fix there keeps a menu's actions on the repository it was
  opened for.
- Added here: image diffs, Open folder and Open in terminal, the list that
  draws only the rows on screen, comments on a line answered by Claude Code,
  the Repo tab, syntax colors, the arrow keys, the file filter, Open with, and
  the Markdown preview with its Mermaid diagrams.

**[herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph)** by
Rabeeh T A, MIT License. The History tab is built on it:

- `lanes.js` is its `mods/git-graph/lanes.js`, copied unchanged.
- `history.js` follows its `graph.js` for drawing a row's graph: one stroked
  path per color, the curve between lanes, the HEAD ring, the lane colors, the
  label look, whole-pixel rows and paging.
- `git.js` follows its `git.js` for parsing refs, the history's scope, the
  uncommitted row, pairing a branch with its remote, and trimming git's errors.
- `menu.js` follows its `menu.js` for the menu's look and keys.
- Most icons are its icons (Lucide, below).
- The panel listens to its `git-graph.changed` signal and sends the same one,
  so with both installed, an action in either refreshes the other.

Its license is in [LICENSES/MIT-herdr-git-graph.txt](LICENSES/MIT-herdr-git-graph.txt).

**Herdr's Changes panel** ([herdr.dev](https://herdr.dev)), Apache License 2.0.
This mod started as `herdr-app do mod.clone '{"name":"changes"}'` of the panel
shipped with Herdr 0.1.11 (`mod.json` still records `cloned_from`).

- Kept from it: how the panel finds the focused repository, the folder watch,
  the context-keyed refresh, the read-only git flags, and the diff row.
- Changed or added: everything else. Staging, the folder tree, the commit
  area, stashes, remotes, history, menus and the diff tab are new.

Apache 2.0 text: [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

**[Lucide](https://lucide.dev)**, ISC License. The icons are Lucide's, as
herdr-git-graph and Herdr draw them; `chevron-*.svg` come from Herdr's Files
panel. `columns`, `diff`, `eye`, `file`, `folder`, `history`, `list`, `list-tree`,
`message-square-plus`, `minus`, `rows`, `search`, `sliders`, `undo` and `x` were added here from Lucide. See
[LICENSES/ISC-Lucide.txt](LICENSES/ISC-Lucide.txt).

**[better-changes](https://github.com/munza/herdr-mods/tree/main/better-changes)**
by Tawsif Aqib, Apache License 2.0. Three ideas come from it:
- opening the diff in one reusable tab of the main area;
- the Tree/Flat and One/Two-column icon pairs;
- two columns that pair lines by position inside a block, on one shared
  vertical scroll.

Its code isn't used here.

**[Zed](https://zed.dev)**'s git panel is the model for the layout: the
Changes/History tabs, the staging checkboxes, Commit vs Commit Tracked, the
branch row's remote button and the suggested commit message. No Zed code is
used.

## License

MIT, see [LICENSE](LICENSE). The borrowed parts keep their own licenses, listed
in [NOTICE](NOTICE) and under [Credits](#credits).
