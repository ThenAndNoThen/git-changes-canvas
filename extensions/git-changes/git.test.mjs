import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename, rm, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compare as compareLocal, disposeComparison, fileDiff, fileSources, git, parseFiles, parsePatch, repository } from "./git.mjs";
import { createPanel, initialSettings } from "./server.mjs";
import { createReviewStore } from "./reviews.mjs";
import { fullFileChanges, fullFileSections, groups, splitRows, wordRange } from "./diff-model.mjs";

let repo;
let beforeStatus;
let panel;
let baseCommit;
let featureCommit;
let result;
const comparisons = [];
async function compare(input) {
    const result = await compareLocal({ includeUncommitted: false, ...input });
    comparisons.push(result);
    return result;
}

before(async () => {
    repo = await mkdtemp(join(process.cwd(), "git-changes-fixture-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Canvas fixture"]);
    await git(repo, ["config", "user.email", "fixture@example.invalid"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await writeFile(join(repo, "changes.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    await writeFile(join(repo, "old name.txt"), "unchanged content for rename\n");
    await writeFile(join(repo, "delete.txt"), "delete me\n");
    await writeFile(join(repo, "bracket[1].txt"), "literal original\n");
    await writeFile(join(repo, "bracket1.txt"), "must not appear in bracket diff\n");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "shared ancestor"]);
    baseCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["branch", "feature", baseCommit]);
    await writeFile(join(repo, "main-only.txt"), "main branch only\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "main change"]);
    await git(repo, ["switch", "feature"]);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[1] = "line TWO updated";
    lines[24] = "line TWENTY-FIVE updated";
    await writeFile(join(repo, "changes.txt"), lines.join("\n") + "\n");
    await rename(join(repo, "old name.txt"), join(repo, "renamed café.txt"));
    await rm(join(repo, "delete.txt"));
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 8, 9]));
    await writeFile(join(repo, "bracket[1].txt"), "literal changed\n");
    await writeFile(join(repo, "bracket1.txt"), "unrelated updated\n");
    await writeFile(join(repo, "empty.txt"), "");
    await writeFile(join(repo, "no-newline.txt"), "<script>alert('not executable')</script>");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feature changes"]);
    featureCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    beforeStatus = await git(repo, ["status", "--porcelain=v1"]);
    panel = await createPanel({}, join(repo, ".git", "test-preferences.json"));
});

after(async () => {
    await panel?.close();
    await Promise.all(comparisons.map(disposeComparison));
    if (repo) {
        assert.equal(await git(repo, ["status", "--porcelain=v1"]), beforeStatus);
        if (process.env.GIT_CHANGES_KEEP_FIXTURE === "1") console.error(`FIXTURE=${repo}`);
        else await rm(repo, { recursive: true, force: true });
    }
});

test("HEAD includes a frozen staged, unstaged and untracked snapshot without changing the repository", async () => {
    const root = await mkdtemp(join(process.cwd(), "git-changes-working-"));
    try {
        await git(root, ["init", "-b", "main"]);
        await git(root, ["config", "user.name", "Canvas fixture"]);
        await git(root, ["config", "user.email", "fixture@example.invalid"]);
        await git(root, ["config", "core.autocrlf", "true"]);
        await writeFile(join(root, ".gitignore"), "*.ignored\n");
        for (const name of ["mixed.txt", "staged.txt", "deleted.txt", "cancelled.txt"]) await writeFile(join(root, name), "original\r\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["branch", "historical"]);
        await writeFile(join(root, "committed.txt"), "branch change\r\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "branch"]);
        await writeFile(join(root, "mixed.txt"), "staged\r\n");
        await writeFile(join(root, "staged.txt"), "staged only\r\n");
        await writeFile(join(root, "kept.ignored"), "explicitly staged\r\n");
        await writeFile(join(root, "cancelled.txt"), "staged but reverted on disk\r\n");
        await git(root, ["add", "--force", "mixed.txt", "staged.txt", "kept.ignored", "cancelled.txt"]);
        await git(root, ["update-index", "--split-index"]);
        await writeFile(join(root, "mixed.txt"), "working\r\n");
        await writeFile(join(root, "cancelled.txt"), "original\r\n");
        await rm(join(root, "deleted.txt"));
        await writeFile(join(root, "new [1].txt"), "untracked\r\n");
        await writeFile(join(root, "empty.txt"), "");
        await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
        await writeFile(join(root, "skip.ignored"), "ignored\r\n");
        const indexBefore = await readFile(join(root, ".git", "index"));
        const objectsBefore = await git(root, ["count-objects", "-v"]);
        const statusBefore = await git(root, ["status", "--porcelain=v1"]);
        const refsBefore = await git(root, ["show-ref"]);
        const snapshot = await compareLocal({ repo: root, base: "historical", target: "HEAD" });
        comparisons.push(snapshot);
        assert.equal(snapshot.includesUncommitted, true);
        assert.deepEqual(snapshot.files.map((file) => file.path), ["binary.bin", "committed.txt", "deleted.txt", "empty.txt", "kept.ignored", "mixed.txt", "new [1].txt", "staged.txt"]);
        assert.equal(snapshot.files.find((file) => file.path === "binary.bin").binary, true);
        assert.equal(snapshot.files.find((file) => file.path === "deleted.txt").status, "D");
        assert.equal((await fileSources(snapshot, "mixed.txt")).target.text, "working\n");
        assert.equal((await fileSources(snapshot, "staged.txt")).target.text, "staged only\n");
        assert.equal((await fileSources(snapshot, "kept.ignored")).target.text, "explicitly staged\n");
        const added = await fileDiff(snapshot, "new [1].txt");
        assert.deepEqual(added.hunks[0].lines.filter((line) => line.type === "add").map((line) => line.text), ["untracked"]);
        assert.equal(added.additions, 1);
        assert.equal((await fileSources(snapshot, "deleted.txt")).target, null);
        assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
        assert.equal(await git(root, ["count-objects", "-v"]), objectsBefore);
        assert.equal(await git(root, ["status", "--porcelain=v1"]), statusBefore);
        assert.equal(await git(root, ["show-ref"]), refsBefore);
        await writeFile(join(root, "mixed.txt"), "later edit\r\n");
        assert.equal((await fileSources(snapshot, "mixed.txt")).target.text, "working\n");
        assert((await fileDiff(snapshot, "mixed.txt")).hunks[0].lines.some((line) => line.text === "working"));
        const refreshed = await compare({ repo: root, base: "historical", target: "HEAD", includeUncommitted: true });
        assert.notEqual(refreshed.id, snapshot.id);
        assert.notEqual(refreshed.files.find((file) => file.path === "mixed.txt").targetObject.id, snapshot.files.find((file) => file.path === "mixed.txt").targetObject.id);
        assert.equal((await fileSources(refreshed, "mixed.txt")).target.text, "later edit\n");
        const historical = await compare({ repo: root, base: "historical", target: "historical", includeUncommitted: true });
        assert.equal(historical.includesUncommitted, false);
        assert.equal(historical.fileCount, 0);
        const committed = await compare({ repo: root, base: "historical", target: "HEAD" });
        assert.deepEqual(committed.files.map((file) => file.path), ["committed.txt"]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("working-tree snapshots preserve sparse files and disable repository clean/process filters", async () => {
    const root = await mkdtemp(join(process.cwd(), "git-changes-sparse-"));
    try {
        await git(root, ["init", "-b", "main"]);
        await git(root, ["config", "user.name", "Canvas fixture"]);
        await git(root, ["config", "user.email", "fixture@example.invalid"]);
        await mkdir(join(root, "included"));
        await mkdir(join(root, "excluded"));
        await writeFile(join(root, "included", "text.txt"), "base\n");
        await writeFile(join(root, "excluded", "text.txt"), "not checked out\n");
        await writeFile(join(root, ".gitattributes"), "included/text.txt filter=forbidden\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["sparse-checkout", "init", "--cone"]);
        await git(root, ["sparse-checkout", "set", "included"]);
        await git(root, ["config", "filter.forbidden.clean", "exit 1"]);
        await git(root, ["config", "filter.forbidden.process", "exit 1"]);
        await git(root, ["config", "filter.forbidden.required", "true"]);
        await writeFile(join(root, "included", "text.txt"), "changed\n");
        const snapshot = await compare({ repo: root, base: "HEAD", target: "HEAD", includeUncommitted: true });
        assert.deepEqual(snapshot.files.map((file) => file.path), ["included/text.txt"]);
        assert.equal((await fileSources(snapshot, "included/text.txt")).target.text, "changed\n");
        assert.match(await git(root, ["ls-files", "-v", "excluded/text.txt"]), /^S /);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshotting preserves Git's racy-index detection for same-size edits", async () => {
    const root = await mkdtemp(join(process.cwd(), "git-changes-racy-"));
    try {
        await git(root, ["init", "-b", "main"]);
        await git(root, ["config", "user.name", "Canvas fixture"]);
        await git(root, ["config", "user.email", "fixture@example.invalid"]);
        await git(root, ["config", "core.autocrlf", "false"]);
        await git(root, ["config", "core.trustctime", "false"]);
        await git(root, ["config", "core.checkStat", "minimal"]);
        const file = join(root, "racy.txt");
        const timestamp = new Date(Date.now() - 10000);
        await writeFile(file, "before\n");
        await utimes(file, timestamp, timestamp);
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "base"]);
        await writeFile(file, "after!\n");
        await utimes(file, timestamp, timestamp);
        await utimes(join(root, ".git", "index"), timestamp, timestamp);
        const snapshot = await compare({ repo: root, base: "HEAD", target: "HEAD", includeUncommitted: true });
        assert.deepEqual(snapshot.files.map((file) => file.path), ["racy.txt"]);
        assert.equal((await fileSources(snapshot, "racy.txt")).target.text, "after!\n");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("A...B excludes A-only changes while A B includes them", async () => {
    result = await compare({ repo, base: "main", target: "feature", mode: "merge-base" });
    assert.equal(result.from, baseCommit);
    assert.equal(result.right, featureCommit);
    assert(!result.files.some((file) => file.path === "main-only.txt"));
    const endpoints = await compare({ repo, base: "main", target: "feature", mode: "endpoints" });
    assert(endpoints.files.some((file) => file.path === "main-only.txt" && file.status === "D"));
    const reversed = await compare({ repo, base: "feature", target: "main", mode: "merge-base" });
    assert.deepEqual(reversed.files.map((file) => file.path), ["main-only.txt"]);
});

test("local Git objects preserve deleted and un-checked-out files, binary and empty-file stats", async () => {
    const renamed = result.files.find((file) => file.path === "renamed café.txt");
    assert.equal(renamed.oldPath, null);
    assert.equal(renamed.path, "renamed café.txt");
    assert.equal(renamed.status, "A");
    assert.equal(renamed.additions, 1);
    assert.equal(result.files.find((file) => file.path === "binary.bin").binary, true);
    assert.equal(result.files.find((file) => file.path === "empty.txt").additions, 0);
    assert.equal(result.files.find((file) => file.path === "delete.txt").status, "D");
    assert.equal(result.files.find((file) => file.path === "old name.txt").status, "D");
    assert.equal((await fileDiff(result, "delete.txt")).hunks[0].lines.filter((line) => line.type === "delete").length, 1);
    assert.equal((await fileDiff(result, renamed.path)).hunks.length, 1);
    assert.equal((await fileDiff(result, "binary.bin")).hunks.length, 0);
    await rm(join(repo, renamed.path));
    try {
        const notCheckedOut = await compare({ repo, base: "main", target: "feature" });
        assert.deepEqual(notCheckedOut.files, result.files);
        assert.equal((await fileDiff(notCheckedOut, renamed.path)).hunks.length, 1);
    } finally { await writeFile(join(repo, renamed.path), "unchanged content for rename\n"); }
});

test("file diffs preserve line numbers, no-newline notes, separate hunks and literal pathspecs", async () => {
    const changed = await fileDiff(result, "changes.txt");
    assert.equal(changed.hunks.length, 2);
    assert.deepEqual(changed.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.type === "add").map((line) => line.newLine)), [2, 25]);
    const literal = await fileDiff(result, "bracket[1].txt");
    assert(!JSON.stringify(literal).includes("unrelated updated"));
    const noNewline = await fileDiff(result, "no-newline.txt");
    assert(noNewline.hunks[0].lines.some((line) => line.type === "note"));
    await assert.rejects(fileDiff(result, "../not-listed"), /not part/);
});

test("full-file sources use pinned comparison blobs, including deletion and empty files", async () => {
    const sources = await fileSources(result, "changes.txt");
    assert.equal(sources.base.revision, baseCommit);
    assert.equal(sources.target.revision, featureCommit);
    assert.equal(sources.base.text, await git(repo, ["show", `${baseCommit}:changes.txt`]));
    assert.equal(sources.target.text, await git(repo, ["show", `${featureCommit}:changes.txt`]));
    assert(sources.target.text.includes("line 15\n"));
    const deleted = await fileSources(result, "delete.txt");
    assert.equal(deleted.target, null);
    assert.equal(deleted.base.text, "delete me\n");
    const empty = await fileSources(result, "empty.txt");
    assert.equal(empty.base, null);
    assert.equal(empty.target.text, "");
    const binary = await fileSources(result, "binary.bin");
    assert.equal(binary.target, null);
    assert.match(binary.unavailableReason, /Binary/);
    await assert.rejects(fileSources(result, "../not-listed"), /not part/);
});

test("moving a branch after comparison does not change the displayed snapshot", async () => {
    await git(repo, ["branch", "moving-ref", featureCommit]);
    const snapshot = await compare({ repo, base: "main", target: "moving-ref" });
    await git(repo, ["update-ref", "refs/heads/moving-ref", result.left]);
    const file = await fileDiff(snapshot, "changes.txt");
    assert.equal(file.hunks.length, 2);
    assert.equal(snapshot.right, featureCommit);
    assert.equal((await fileSources(snapshot, "changes.txt")).target.revision, featureCommit);
    assert.equal((await compare({ repo, base: "main", target: "moving-ref" })).fileCount, 0);
});

test("patch parser handles zero-count ranges and content resembling patch headers", () => {
    const parsed = parsePatch("@@ -0,0 +1,2 @@\n++++ not a header\n+@@ text\n\\ No newline at end of file\n");
    assert.deepEqual(parsed.hunks[0].lines.map((line) => line.newLine), [1, 2, null]);
    assert.equal(parsed.hunks[0].lines[0].text, "+++ not a header");
    const files = parseFiles("M\0tab\tname.txt\0R100\0old\nname\0new\nname\0", ["1\t2\ttab\tname.txt", "0\t0\t", "old\nname", "new\nname", ""].join("\0"));
    assert.equal(files[0].deletions, 2);
    assert.equal(files[1].path, "new\nname");
});

test("change blocks and split rows align additions and deletions", () => {
    const lines = [
        { type: "context", text: "same" },
        { type: "delete", text: "old" },
        { type: "delete", text: "old2" },
        { type: "add", text: "new" },
        { type: "context", text: "next" },
        { type: "add", text: "extra" },
    ];
    const blocks = groups(lines);
    assert.equal(blocks.filter((group) => group.changed).length, 2);
    const rows = splitRows(blocks[1].lines);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].right.text, "new");
    assert.equal(rows[1].right, null);
    assert.deepEqual(wordRange("prefix old suffix", "prefix new suffix"), { start: 7, endLeft: 10, endRight: 10 });
});

test("full-file navigation projects replacements and deleted blocks onto the displayed version", () => {
    const mixed = parsePatch("@@ -1,5 +1,4 @@\n a\n-remove\n b\n-c\n+C\n end\n");
    const changes = fullFileChanges(mixed.hunks, "right");
    assert.deepEqual(changes, [
        { start: 2, end: 2, type: "delete", marker: true, hiddenLines: 1 },
        { start: 3, end: 3, type: "add", marker: false, hiddenLines: 1 },
    ]);
    const beginning = parsePatch("@@ -1,2 +1 @@\n-old\n same\n");
    assert.equal(fullFileChanges(beginning.hunks, "right")[0].start, 1);
    const end = parsePatch("@@ -9,2 +9 @@\n keep\n-tail\n");
    assert.equal(fullFileChanges(end.hunks, "right")[0].start, 10);
    const emptied = parsePatch("@@ -1,2 +0,0 @@\n-a\n-b\n");
    assert.deepEqual(fullFileChanges(emptied.hunks, "right"), [
        { start: 1, end: 1, type: "delete", marker: true, hiddenLines: 2 },
    ]);
    assert.deepEqual(fullFileChanges(emptied.hunks, "left"), [
        { start: 1, end: 2, type: "delete", marker: false, hiddenLines: 0 },
    ]);
    const added = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n");
    assert.deepEqual(fullFileChanges(added.hunks, "right"), [
        { start: 1, end: 2, type: "add", marker: false, hiddenLines: 0 },
    ]);
});

test("full-file side-by-side alignment preserves both complete sources and pads unequal changes", () => {
    const left = ["before", "old1", "old2", "middle", "tail"];
    const right = ["before", "new", "middle", "added1", "added2", "tail"];
    const patch = parsePatch("@@ -1,5 +1,6 @@\n before\n-old1\n-old2\n+new\n middle\n+added1\n+added2\n tail\n");
    const sections = [...fullFileSections(left, right, patch.hunks)];
    const rows = sections.flatMap((section) => section.rows);
    assert.deepEqual(rows.flatMap((row) => row.left ? [row.left.text] : []), left);
    assert.deepEqual(rows.flatMap((row) => row.right ? [row.right.text] : []), right);
    assert.deepEqual(rows.flatMap((row) => row.left ? [row.left.oldLine] : []), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows.flatMap((row) => row.right ? [row.right.newLine] : []), [1, 2, 3, 4, 5, 6]);
    assert.equal(sections.filter((section) => section.changed).length, 2);
    assert.equal(rows[2].left.text, "old2");
    assert.equal(rows[2].right, null);
    assert.equal(rows[3].left.text, rows[3].right.text);
    assert.equal(rows[4].left, null);
    assert.equal(rows[4].right.text, "added1");
    assert.equal(rows.at(-1).left.text, rows.at(-1).right.text);
});

test("full-file side-by-side handles complete addition, deletion, empty and unchanged files", () => {
    const added = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n");
    const removed = parsePatch("@@ -1,2 +0,0 @@\n-a\n-b\n");
    const additions = [...fullFileSections([], ["a", "b"], added.hunks)];
    assert.equal(additions.length, 1);
    assert(additions[0].rows.every((row) => row.left === null && row.right.type === "add"));
    const deletions = [...fullFileSections(["a", "b"], [], removed.hunks)];
    assert(deletions[0].rows.every((row) => row.right === null && row.left.type === "delete"));
    assert.deepEqual([...fullFileSections([], [], [])], []);
    const unchanged = [...fullFileSections(["same", ""], ["same", ""], [])];
    assert.equal(unchanged[0].changed, false);
    assert.equal(unchanged[0].rows.length, 2);
});

test("invalid revisions and mode cannot become command-line options", async () => {
    await assert.rejects(compare({ repo, base: "HEAD", target: "HEAD", includeUncommitted: "yes" }), /Invalid uncommitted/);
    await assert.rejects(compare({ repo, base: "--help", target: "HEAD" }), /revision|single|unknown|Needed/);
    await assert.rejects(compare({ repo, base: "main", target: "HEAD", mode: "bad" }), /Unknown comparison/);
    await assert.rejects(compare({ repo: "relative", base: "main", target: "HEAD" }), /absolute/);
});

test("unrelated histories and ambiguous merge bases produce actionable errors", async () => {
    const tree = (await git(repo, ["rev-parse", `${baseCommit}^{tree}`])).trim();
    const unrelated = (await git(repo, ["commit-tree", tree, "-m", "unrelated root"])).trim();
    await assert.rejects(compare({ repo, base: unrelated, target: featureCommit }), /no common ancestor/);
    const a = (await git(repo, ["commit-tree", tree, "-p", baseCommit, "-m", "side a"])).trim();
    const b = (await git(repo, ["commit-tree", tree, "-p", baseCommit, "-m", "side b"])).trim();
    const m1 = (await git(repo, ["commit-tree", tree, "-p", a, "-p", b, "-m", "merge ab"])).trim();
    const m2 = (await git(repo, ["commit-tree", tree, "-p", b, "-p", a, "-m", "merge ba"])).trim();
    await assert.rejects(compare({ repo, base: m1, target: m2 }), /Multiple merge bases/);
});

test("HTTP controls expose comparison, reject stale files and cross-origin requests", async () => {
    const post = (route, data, headers = {}) => fetch(panel.url + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Git-Changes": "1", ...headers },
        body: JSON.stringify(data),
    });
    const response = await post("compare", { repo, base: "main", target: "feature", mode: "merge-base", includeUncommitted: false });
    assert.equal(response.status, 200);
    const comparison = await response.json();
    assert.equal(comparison.id, result.id);
    assert.equal((await post("file", { path: "changes.txt", comparisonId: "old" })).status, 400);
    assert.equal((await post("file", { path: "changes.txt", comparisonId: comparison.id })).status, 200);
    const withSources = await (await post("file", { path: "changes.txt", comparisonId: comparison.id, includeSources: true })).json();
    assert(withSources.sources.target.text.includes("line TWENTY-FIVE updated"));
    assert.equal((await post("file", { path: "changes.txt", includeSources: "yes" })).status, 400);
    assert.equal((await post("repository", { repo }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await fetch(new URL("/state", panel.url))).status, 404);
    const noHeader = await fetch(panel.url + "repository", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
    assert.equal(noHeader.status, 405);
    assert.match(await (await fetch(panel.url)).text(), /Git Changes/);
    assert.match(await (await fetch(panel.url + "app.js")).text(), /navigate/);
    assert.equal((await fetch(panel.url + "diff-model.mjs")).status, 200);
});

test("view settings survive reopening without overriding explicit comparison refs", async () => {
    const response = await fetch(panel.url + "preferences", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Git-Changes": "1" },
        body: JSON.stringify({ comparisonId: result.id, view: "unified", wrap: true, fullFile: true, selectedPath: "changes.txt" }),
    });
    assert.equal(response.status, 200);
    const second = await createPanel({ repo, base: "main", target: "HEAD" }, join(repo, ".git", "test-preferences.json"));
    try {
        const saved = await (await fetch(second.url + "state")).json();
        assert.equal(saved.settings.base, "main");
        assert.equal(saved.settings.target, "HEAD");
        assert.equal(saved.settings.selectedPath, "changes.txt");
        assert.equal(saved.settings.view, "unified");
        assert.equal(saved.settings.wrap, true);
        assert.equal(saved.settings.fullFile, true);
    } finally { await second.close(); }
});

test("file review marks persist per worktree and compared versions without losing concurrent updates", async () => {
    const root = await mkdtemp(join(process.cwd(), "file-review-test-"));
    const panels = [];
    try {
        await git(root, ["init", "-b", "main"]);
        await git(root, ["config", "user.name", "Canvas fixture"]);
        await git(root, ["config", "user.email", "fixture@example.invalid"]);
        await git(root, ["config", "core.autocrlf", "false"]);
        await writeFile(join(root, "first.txt"), "original one\n");
        await writeFile(join(root, "second.txt"), "original two\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "base"]);
        const base = (await git(root, ["rev-parse", "HEAD"])).trim();
        await writeFile(join(root, "first.txt"), "intermediate one\n");
        await git(root, ["commit", "-am", "intermediate"]);
        const alternateBase = (await git(root, ["rev-parse", "HEAD"])).trim();
        await writeFile(join(root, "first.txt"), "target one\n");
        await writeFile(join(root, "second.txt"), "target two\n");
        await mkdir(join(root, "src", "nested"), { recursive: true });
        await mkdir(join(root, "src2"));
        for (const path of ["src/a.txt", "src/nested/b.txt", "src2/c.txt"]) await writeFile(join(root, path), "new source\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-am", "target"]);
        const storage = join(root, ".git", "file-review-settings.json");
        const options = { repo: root, base, target: "HEAD", mode: "endpoints" };
        async function open(repo = root) {
            const instance = await createPanel({ repo }, storage);
            panels.push(instance);
            await instance.compare({ ...options, repo });
            return instance;
        }
        const first = await open();
        const second = await open();
        const post = (instance, route, data) => fetch(instance.url + route, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Git-Changes": "1" },
            body: JSON.stringify(data),
        });
        const marks = async (instance) => (await (await fetch(instance.url + "file-reviews")).json()).paths.sort();
        const id = first.summary().comparison.id;
        const responses = await Promise.all([
            post(first, "file-reviews", { comparisonId: id, path: "first.txt", reviewed: true }),
            post(second, "file-reviews", { comparisonId: id, path: "second.txt", reviewed: true }),
            post(first, "preferences", { comparisonId: id, selectedPath: "first.txt", view: "split", wrap: false }),
        ]);
        assert(responses.every((response) => response.status === 200));
        assert.deepEqual(await marks(first), ["first.txt", "second.txt"]);
        assert.deepEqual(await marks(await open()), ["first.txt", "second.txt"]);
        for (const data of [
            { comparisonId: "stale", path: "first.txt", reviewed: true },
            { comparisonId: id, path: "../outside.txt", reviewed: true },
            { comparisonId: id, path: "first.txt", reviewed: "yes" },
        ]) assert.equal((await post(first, "file-reviews", data)).status, 400);
        assert.deepEqual(await marks(first), ["first.txt", "second.txt"]);

        await first.compare({ ...options, base: alternateBase });
        assert.deepEqual(await marks(first), ["second.txt"], "A changed base invalidates the mark even when the target is unchanged");
        const alternateId = first.summary().comparison.id;
        assert.equal((await post(first, "file-reviews", { comparisonId: alternateId, path: "first.txt", reviewed: true })).status, 200);
        assert.deepEqual(await marks(second), ["first.txt", "second.txt"], "Reviewing another version must not replace the original version's mark");
        assert.equal((await post(first, "file-reviews", { comparisonId: alternateId, path: "first.txt", reviewed: false })).status, 200);
        assert.deepEqual(await marks(second), ["first.txt", "second.txt"], "Unchecking another version must not clear the original mark");
        await first.compare(options);
        await writeFile(join(root, "first.txt"), "new working-tree text\n");
        await first.compare(options);
        assert.deepEqual(await marks(first), ["second.txt"], "Changed uncommitted content must not retain an old mark");
        assert.equal((await post(first, "file-reviews", {
            comparisonId: first.summary().comparison.id, path: "second.txt", reviewed: false,
        })).status, 200);
        assert.deepEqual(await marks(first), []);
        const currentId = first.summary().comparison.id;
        const directoryUpdate = { comparisonId: currentId, directory: "src", reviewed: true };
        assert.equal((await post(first, "file-reviews", directoryUpdate)).status, 200);
        assert.deepEqual(await marks(first), ["src/a.txt", "src/nested/b.txt"], "Directory updates must include descendants but exclude similar prefixes");
        for (const data of [
            { ...directoryUpdate, comparisonId: "stale" },
            { ...directoryUpdate, directory: "missing" },
            { ...directoryUpdate, directory: "" },
            { ...directoryUpdate, directory: 1 },
            { ...directoryUpdate, path: "second.txt" },
        ]) assert.equal((await post(first, "file-reviews", data)).status, 400);
        assert.deepEqual(await marks(first), ["src/a.txt", "src/nested/b.txt"], "Rejected batch updates must leave all marks unchanged");
        const concurrent = await Promise.all([
            post(first, "file-reviews", { ...directoryUpdate, reviewed: false }),
            post(first, "file-reviews", { comparisonId: currentId, path: "src2/c.txt", reviewed: true }),
        ]);
        assert(concurrent.every((response) => response.status === 200));
        assert.deepEqual(await marks(first), ["src2/c.txt"], "Unchecking a directory must preserve concurrent unrelated marks");
        const worktree = join(root, ".git", "other-worktree");
        await git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
        assert.deepEqual(await marks(await open(worktree)), [], "Another worktree must not inherit reviewed files");
        const saved = JSON.parse(await readFile(storage, "utf8"));
        assert.equal(saved.repositories.find((entry) => entry.repo === root).view, "split");
    } finally {
        for (const instance of panels) await instance.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("opaque-origin sandbox requests work only through the capability URL", async () => {
    for (const route of ["app.js", "diff-model.mjs", "syntax.mjs", "vendor/highlight.mjs", "state"]) {
        const response = await fetch(panel.url + route, { headers: { Origin: "null" } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), "null");
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
    }
    const preflight = await fetch(panel.url + "compare", {
        method: "OPTIONS",
        headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-git-changes" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "null");
    const compareResponse = await fetch(panel.url + "compare", {
        method: "POST",
        headers: { Origin: "null", "Content-Type": "application/json", "X-Git-Changes": "1" },
        body: JSON.stringify({ repo, base: "main", target: "feature" }),
    });
    assert.equal(compareResponse.status, 200);
    const invalid = await fetch(new URL("/wrong-token/state", panel.url), { headers: { Origin: "null" } });
    assert.equal(invalid.status, 404);
    assert.equal(invalid.headers.get("access-control-allow-origin"), null);
    const denied = await fetch(panel.url + "state", { headers: { Origin: "https://example.invalid" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("review HTTP routes validate pinned ranges, comparison identity and user-only resolution", async () => {
    const sent = [];
    const store = await createReviewStore(join(repo, ".git", "http-reviews.json"), async (prompt) => { sent.push(prompt); return "sent"; });
    const reviewPanel = await createPanel({ repo }, join(repo, ".git", "review-settings.json"), { reviews: store });
    const post = (route, data) => fetch(reviewPanel.url + route, {
        method: "POST", headers: { Origin: "null", "Content-Type": "application/json", "X-Git-Changes": "1" },
        body: JSON.stringify(data),
    });
    try {
        const snapshot = await reviewPanel.compare({ repo, base: "main", target: "feature" });
        const payload = {
            comparisonId: snapshot.id, path: "changes.txt", side: "target", startLine: 2, endLine: 2,
            startColumn: 0, endColumn: 4, body: "Review these characters", requestId: "http-review-request",
        };
        assert.equal((await post("reviews/create", { ...payload, comparisonId: "stale" })).status, 400);
        assert.equal((await post("reviews/create", { ...payload, path: "../outside" })).status, 400);
        assert.equal((await post("reviews/create", { ...payload, endColumn: 999 })).status, 400);
        const response = await post("reviews/create", { ...payload, quote: "browser cannot forge the source" });
        assert.equal(response.status, 200);
        const thread = await response.json();
        assert.equal(thread.anchor.quote, "line");
        assert.equal(sent.length, 1);
        const listing = await (await fetch(reviewPanel.url + "reviews")).json();
        assert.equal(listing.threads.length, 1);
        await store.agentReply(thread.id, thread.messages[0].id, "Done");
        assert.equal((await post("reviews/resolve", { comparisonId: snapshot.id, threadId: thread.id, revision: thread.revision, resolved: true })).status, 400);
        assert.equal((await post("reviews/resolve", { comparisonId: snapshot.id, threadId: thread.id, revision: store.read(thread.id).revision, resolved: true })).status, 200);
        assert.equal(store.read(thread.id).resolved, true);
    } finally { await reviewPanel.close(); }
});

test("a workspace without its first commit still selects its repository and branch", async () => {
    const emptyRepo = await mkdtemp(join(process.cwd(), "git-changes-unborn-"));
    let emptyPanel;
    try {
        await git(emptyRepo, ["init", "-b", "new-project"]);
        const nested = join(emptyRepo, "src");
        await mkdir(nested);
        const status = await git(emptyRepo, ["status", "--porcelain=v1"]);
        const storage = join(emptyRepo, ".git", "settings.json");
        await writeFile(storage, JSON.stringify({
            lastRepo: repo, repositories: [{ repo, base: "main", target: "feature" }],
        }));
        emptyPanel = await createPanel({}, storage, { workingDirectory: nested });
        const { settings, workspace } = emptyPanel.summary();
        assert.equal(settings.repo, emptyRepo);
        assert.equal(settings.target, "new-project");
        assert.equal(settings.base, "HEAD");
        assert.equal(workspace.source, "workspace");
        assert.equal((await repository(emptyRepo)).unborn, true);
        await writeFile(join(emptyRepo, "new.txt"), "before first commit\n");
        const snapshot = await compare({ repo: emptyRepo, base: "HEAD", target: "new-project", includeUncommitted: true });
        assert.deepEqual(snapshot.files.map((file) => file.path), ["new.txt"]);
        assert.equal((await fileSources(snapshot, "new.txt")).target.text, "before first commit\n");
        await rm(join(emptyRepo, "new.txt"));
        assert.equal(await git(emptyRepo, ["status", "--porcelain=v1"]), status);
    } finally {
        await emptyPanel?.close();
        await rm(emptyRepo, { recursive: true, force: true });
    }
});

test("owning worktree and checked-out branch win over global history", async () => {
    const worktree = `${repo}-worktree`;
    await git(repo, ["update-ref", "refs/remotes/origin/main", result.left]);
    await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(repo, ["worktree", "add", "-b", "workspace-feature", worktree, "feature"]);
    try {
        const nested = join(worktree, "nested");
        await mkdir(nested);
        const saved = { lastRepo: repo, repositories: [{ repo, base: "feature", target: "main" }] };
        const noWorkspace = await initialSettings({}, saved);
        assert.deepEqual(noWorkspace.settings, {});
        assert.equal(noWorkspace.workspace.source, "none");
        const initial = await initialSettings({}, saved, nested);
        assert.equal(initial.settings.repo, worktree);
        assert.equal(initial.settings.base, "origin/main");
        assert.equal(initial.settings.target, "workspace-feature");
        assert.equal(initial.workspace.source, "workspace");
        assert.equal((await repository(nested)).unborn, false);
        assert.equal((await compare(initial.settings)).fileCount, result.fileCount);
        await git(worktree, ["switch", "--detach", "HEAD"]);
        assert.equal((await initialSettings({}, saved, nested)).settings.target, "HEAD");
        assert.equal((await repository(nested)).unborn, false);
        const explicit = await initialSettings({ repo, base: "main", target: "feature" }, saved, nested);
        assert.equal(explicit.settings.repo, repo);
        assert.equal(explicit.settings.target, "feature");
        await assert.rejects(initialSettings({ repo: join(repo, "does-not-exist") }, saved, nested), /ENOENT/);
    } finally {
        await git(repo, ["worktree", "remove", "--force", worktree]);
    }
});

test("partial clones skip only missing Git objects, not absent working-tree files, without fetching", async () => {
    const partial = `${repo}-partial`;
    await git(repo, ["config", "uploadpack.allowFilter", "true"]);
    await git(repo, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(repo, ["clone", "--quiet", "--filter=blob:none", "--no-checkout", pathToFileURL(repo).href, partial]);
    try {
        await git(partial, ["remote", "set-url", "origin", "http://127.0.0.1:1/must-not-fetch"]);
        const args = ["diff", "--no-ext-diff", "--no-textconv", "--numstat", result.left, featureCommit];
        await assert.rejects(git(partial, args), /lazy fetching disabled/);
        const refsBefore = await git(partial, ["show-ref"]);
        const objectsBefore = await git(partial, ["count-objects", "-v"]);
        const input = { repo: partial, base: result.left, target: featureCommit };
        const absent = await compare(input);
        assert.equal(absent.fileCount, 0);
        assert(absent.skipped.length > 0);
        assert(absent.skipped.some((file) => file.path === "changes.txt"));
        const content = await git(repo, ["show", `${featureCommit}:changes.txt`]);
        await writeFile(join(partial, "changes.txt"), content);
        const skipped = await compare(input);
        assert.equal(skipped.fileCount, 0);
        assert.deepEqual(skipped.skipped, absent.skipped);
        assert.equal(await git(partial, ["show-ref"]), refsBefore);
        assert.equal(await git(partial, ["count-objects", "-v"]), objectsBefore);
        await assert.rejects(git(partial, args), /lazy fetching disabled/);
        // Simulate history objects already present locally, without any remote.
        for (const ref of [result.left, featureCommit]) {
            const text = await git(repo, ["show", `${ref}:changes.txt`]);
            await git(partial, ["hash-object", "-w", "--stdin"], undefined, text);
        }
        await rm(join(partial, "changes.txt"));
        const loaded = await compare(input);
        assert.deepEqual(loaded.files.map((file) => file.path), ["changes.txt"]);
        assert.equal(loaded.skipped.length, absent.skipped.length - 1);
        assert.equal((await fileDiff(loaded, "changes.txt")).hunks.length, 2);
    } finally {
        await rm(partial, { recursive: true, force: true });
    }
});
