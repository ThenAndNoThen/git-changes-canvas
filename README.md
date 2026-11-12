# Git Changes canvas

A read-only Git branch comparison canvas for the GitHub Copilot desktop app, with an English interface, side-by-side full-file views, syntax highlighting, change navigation, and code review comments connected to the owning conversation.

## Features

- Compare any local Git refs using endpoint comparison (`A B`) or common-ancestor comparison (`A...B`), with automatic detection of the owning session's worktree and current branch.
- Filter files, view addition/deletion counts, switch between split/unified diffs and split/single-column full-file views, enable syntax highlighting and wrapping, and navigate changes across files.
- Add comments using the `+` to the left of a line number, shown on hover or code selection. Partial-line selections and Shift-click multi-line selections are supported.
- Send comments to the conversation that owns the canvas. The main agent replies through dedicated tools; users can follow up or resolve threads. Resolved threads collapse by default.
- Navigate comments independently of changes. Comments are pinned to their original Git blobs and marked outdated when code changes, rather than jumping to incorrect locations.
- No branch switching, workspace modifications, or Git object downloads. Files with missing local objects are explicitly reported as skipped.

## Installation and sharing

Requires Git, Node.js (version 22 or later recommended), and a GitHub Copilot desktop app version that supports `joinSession` canvas extensions and custom tools. The canvas SDK is experimental, so compatibility may vary between app versions.

### Install from GitHub (recommended for sharing)

Once the repository is on GitHub, share the **`extensions/git-changes` folder URL**, for example:

```text
https://github.com/<owner>/<repo>/tree/main/extensions/git-changes
```

The recipient can ask Copilot:

```text
Install this canvas extension at user scope: <GitHub folder URL above>
```

The app's `install_extension` tool supports this GitHub folder URL format and reloads extensions after installation. A user-scoped installation is available to sessions on the same machine; other running sessions may need to reload their extensions. Then select Git Changes from the right-panel canvas menu, or ask the agent to open Git Changes in the target repository's session.

### Local installation

Copy the contents of `extensions\git-changes`, including the `vendor` subdirectory, to `$COPILOT_HOME\extensions\git-changes`. When `COPILOT_HOME` is unset, this is usually `~\.copilot\extensions\git-changes`. For an existing installation, preserve its `artifacts` data directory and do not overwrite it with older data. Then reload extensions in the owning session.

**No `npm install` is needed at runtime.** Syntax-highlighting assets are bundled locally, and the Copilot runtime provides `@github/copilot-sdk`. The root npm dependencies are only for development and testing.

### Keep personal runtime data private

The repository contains source code and tests, not personal repository paths, preferences, comments, conversation history, or object caches. `.gitignore` excludes artifacts, preferences, and comment files. Comments are stored in `files\git-changes-reviews.json` under the owning session's directory, outside the extension source.

The app also offers "Share extension as gist...", but do not share an installation directory that contains runtime data: the sharing tool may not honor `.gitignore`. Prefer the clean source folder in this repository. This extension never automatically uploads files, creates remote repositories, or pushes commits.

## Code review workflow

1. Hover over a line number and click the `+` on its left, or select code and click the `+` beside the last selected line. Write a comment and choose "Send to conversation".
2. The extension queues the comment into its owning session through SDK `session.send`, preserving existing permissions, mode, and approval flows. The main agent reads the thread with `git_changes_review_read` and responds with `git_changes_review_reply`; it does not automatically resolve the thread.
3. Use "Send reply" to follow up or "Resolve" to close the thread. Resolved threads collapse and can be expanded to view their history or reopened. Comment navigation visits unresolved threads only.

Comments persist locally across panel closure, extension reloads, and session restoration. Quoted code and user comments are sent to the model used by the session, so the session's data policies and model usage limits still apply. The extension does not post comments to GitHub or Azure DevOps pull requests.

Comments refer to historical commits, which may differ from the current files on disk. The agent must inspect the actual workspace first and explain missing permissions, path mismatches, or unclear requests in its reply. If delivery fails with an uncertain outcome, the comment is preserved with a warning and is not resent automatically.

## Development and validation

```powershell
npm ci --ignore-scripts
npm test
npm run test:browser
```

Browser tests use an installed Microsoft Edge in headless mode and exercise the canvas inside a `sandbox="allow-scripts"` iframe. Tests create and clean up their own temporary Git repositories. Review tests mock the conversation send function and never send test messages to a real session.

To rebuild the syntax-highlighting bundle:

```powershell
npm run build:highlight
```

Preserve `extensions\git-changes\vendor\highlight.LICENSE` after rebuilding. See the [extension documentation](extensions/git-changes/README.md) for comparison semantics, limitations, and security details.

## Publishing

The default branch is `main`. When publishing a new copy without a configured remote, review the source, choose a license for users, create a GitHub repository, and commit and push:

```powershell
git add .
git commit -m "Add Git Changes canvas"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

No project-wide open-source license has been selected. Choose one before distributing the project. The third-party BSD-3-Clause license for highlight.js is included with its assets.
