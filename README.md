# Git Changes canvas

A read-only Git branch comparison canvas for the GitHub Copilot desktop app, with an English interface, side-by-side full-file views, syntax highlighting, change navigation, and code review comments connected to the owning conversation.

## Features

- Compare any local Git refs using endpoint comparison (`A B`) or common-ancestor comparison (`A...B`), with automatic detection of the owning session's worktree and current branch. The compact header contains branch comparison controls only, without a title/logo row or repository picker. When target B resolves to current HEAD, staged, unstaged and untracked changes are included by default; uncheck "Include uncommitted changes" for a commit-only comparison. Other target revisions remain commit-only.
- Filter files, view addition/deletion counts, switch between split/unified diffs and split/single-column full-file views, enable syntax highlighting and wrapping, and navigate changes across files. Drag the divider between code panels to adjust their widths, or focus it and use the arrow keys. The ratio stays while navigating in the current page and resets to equal widths on reload or reopening.
- Added and deleted files always use a full-width single panel in both diff and full-file views, showing the target or base version respectively. Returning to a modified file restores its selected layout.
- Browse changed files in a collapsible directory tree. Check a file to mark it reviewed, or use a directory checkbox to mark/unmark all changed files in that directory and its descendants, including filtered-out files. Directory checkboxes show a partial state when only some files are reviewed, and completed directories collapse automatically. Marks survive reloads and reopening for the same worktree and compared file versions; changed versions are unchecked. These are local review-progress marks, not pull request approvals.
- Add comments using the `+` to the left of a line number, shown on hover or code selection. Partial-line selections and Shift-click multi-line selections are supported.
- Send comments to the conversation that owns the canvas. Colored status labels distinguish waiting (amber), processing (blue), replied (green), uncertain delivery (red), and resolved (muted). Resolved threads collapse and move below unresolved threads; reopening restores their file/line order.
- Navigate comments independently of changes. Diffs, full-file views and comments use frozen snapshots, including uncommitted content; comments are marked outdated after refreshing changed code rather than jumping to incorrect locations.
- No branch switching, workspace modifications, or Git object downloads. Files with missing local objects are explicitly reported as skipped.

## Installation and sharing

Requires Git, Node.js (version 22 or later recommended), and a GitHub Copilot desktop app version that supports `joinSession` canvas extensions and custom tools. The canvas SDK is experimental, so compatibility may vary between app versions.

### Install from GitHub (recommended for sharing)

Share the **[`extensions/git-changes` folder URL](https://github.com/ThenAndNoThen/git-changes-canvas/tree/main/extensions/git-changes)**, not the repository root:

```text
https://github.com/ThenAndNoThen/git-changes-canvas/tree/main/extensions/git-changes
```

The recipient can ask Copilot:

```text
Install this canvas extension at user scope: https://github.com/ThenAndNoThen/git-changes-canvas/tree/main/extensions/git-changes
```

The app's `install_extension` tool supports this GitHub folder URL format and reloads extensions after installation. A user-scoped installation is available to sessions on the same machine; other running sessions may need to reload their extensions. Then select Git Changes from the right-panel canvas menu, or ask the agent to open Git Changes in the target repository's session.

The recipient must have access to the repository; a folder URL does not grant access to a private repository.

### Local installation

Copy the contents of `extensions\git-changes`, including the `vendor` subdirectory, to the `extensions\git-changes` directory under `COPILOT_HOME` (`$env:COPILOT_HOME` in PowerShell). When `COPILOT_HOME` is unset, this is usually `~\.copilot\extensions\git-changes`. For an existing installation, preserve its `artifacts` data directory and do not overwrite it with older data. Then reload extensions in the owning session.

**No `npm install` is needed at runtime.** Syntax-highlighting assets are bundled locally, and the Copilot runtime provides `@github/copilot-sdk`. The root npm dependencies are only for development and testing.

### Keep personal runtime data private

The repository contains source code and tests, not personal repository paths, preferences, comments, conversation history, or object caches. `.gitignore` excludes artifacts, preferences, and comment files. Comments are stored in `files\git-changes-reviews.json` under the owning session's directory, outside the extension source.

The app also offers "Share extension as gist...", but do not share an installation directory that contains runtime data: the sharing tool may not honor `.gitignore`. Prefer the clean source folder in this repository. This extension never automatically uploads files, creates remote repositories, or pushes commits.

## Code review workflow

1. Hover over a line number and click the `+` on its left, or select code and click the `+` beside the last selected line. Write a comment and choose "Send to conversation".
2. The extension queues the comment into its owning session through SDK `session.send`, preserving existing permissions, mode, and approval flows. The status changes from waiting to processing when the main agent reads the thread with `git_changes_review_read`, and to replied after `git_changes_review_reply`; delivery alone does not imply processing.
3. Use "Send reply" to follow up or "Resolve" to close the thread. Resolved threads collapse, move to the bottom, and can be expanded to view their history or reopened. Comment navigation visits unresolved threads only; the agent never resolves threads automatically.

Comments persist locally across panel closure, extension reloads, and session restoration. Quoted code and user comments are sent to the model used by the session, so the session's data policies and model usage limits still apply. The extension does not post comments to GitHub or Azure DevOps pull requests.

Comments refer to pinned commit or working-tree snapshots, which may differ from the current files on disk. The agent must inspect the actual workspace first and explain missing permissions, path mismatches, or unclear requests in its reply. If delivery fails with an uncertain outcome, the comment is preserved with a warning and is not resent automatically.

## Development and validation

The repository does not set an npm registry. Developers without a custom registry use npm's public default; developers using an organization registry keep their existing user-level or global configuration. Do not commit registry URLs or authentication credentials.

The project `.npmrc` sets `omit-lockfile-registry-resolved=true`, so `package-lock.json` retains pinned versions and integrity hashes without registry download URLs. `npm ci` resolves downloads through your configured registry, which must provide the pinned versions with matching integrity hashes. This can add metadata requests.

```powershell
npm ci --ignore-scripts
npm test
npm run test:browser
```

Run these commands from the repository root. Browser tests use an installed Microsoft Edge in headless mode and exercise the canvas inside a `sandbox="allow-scripts"` iframe. Tests create and clean up disposable fixtures: Git and browser tests use the current working directory, while review unit tests use the OS temporary directory. Review tests mock the conversation send function and never send test messages to a real session.

To rebuild the syntax-highlighting bundle:

```powershell
npm run build:highlight
```

Preserve `extensions\git-changes\vendor\highlight.LICENSE` after rebuilding. See the [extension documentation](extensions/git-changes/README.md) for comparison semantics, limitations, and security details.

## Licensing

No project-wide open-source license has been selected. Choose one before distributing the project. The third-party BSD-3-Clause license for highlight.js is included with its assets.
