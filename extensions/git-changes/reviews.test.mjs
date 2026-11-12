import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewStore, reviewAnchor } from "./reviews.mjs";

const comparison = { id: "snapshot", repo: "fixture", base: "main", target: "feature", mode: "merge-base", from: "a".repeat(40), right: "b".repeat(40) };
const file = { path: "example.cs", baseObject: { id: "c".repeat(40) }, targetObject: { id: "d".repeat(40) } };
const sources = { target: { text: 'first\nsecond line\nthird\n', revision: comparison.right }, base: { text: "old\n", revision: comparison.from } };
const selection = { side: "target", startLine: 1, startColumn: 2, endLine: 2, endColumn: 6 };

test("review anchors store exact multi-line and partial-line ranges from the pinned source", () => {
    const anchor = reviewAnchor(comparison, file, sources, selection);
    assert.equal(anchor.quote, "rst\nsecond");
    assert.equal(anchor.blob, file.targetObject.id);
    assert.equal(anchor.commit, comparison.right);
    assert.throws(() => reviewAnchor(comparison, file, sources, { ...selection, endLine: 400 }), /Invalid code range/);
    assert.throws(() => reviewAnchor(comparison, file, sources, { ...selection, endColumn: 100 }), /Invalid code range/);
    assert.throws(() => reviewAnchor(comparison, file, sources, { ...selection, side: "wrong" }), /same side/);
});

test("user send, main-agent reply, follow-up, resolve and reload preserve a thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-review-"));
    try {
        const path = join(root, "reviews.json");
        const sent = [];
        const displayed = [];
        const store = await createReviewStore(path, async (prompt, displayPrompt) => {
            sent.push(prompt);
            displayed.push(displayPrompt);
            return `sent-${sent.length}`;
        });
        const anchor = reviewAnchor(comparison, file, sources, selection);
        const first = await store.create(comparison, anchor, "Check this code", "request-one");
        assert.equal(first.messages[0].delivery.state, "sent");
        assert.equal(sent.length, 1);
        assert(sent[0].includes(first.id));
        assert(sent[0].includes("git_changes_review_reply"));
        assert(sent[0].includes("pinned historical snapshot"));
        assert(sent[0].includes(JSON.stringify(anchor.quote)));
        assert(sent[0].includes("Check this code"));
        assert.equal(displayed[0], "Review inline code: example.cs:L1-L2");
        await store.create(comparison, anchor, "Check this code", "request-one");
        assert.equal(sent.length, 1, "Double submit must not dispatch twice");
        const replied = await store.agentReply(first.id, first.messages[0].id, "Handled without changing unrelated code.");
        assert.equal(replied.resolved, false);
        assert.equal(replied.messages.at(-1).author, "agent");
        await assert.rejects(store.resolve(first.id, true, first.revision), /has been updated/);
        const follow = await store.userReply(first.id, "Please explain more", replied.revision, "request-two");
        assert.equal(sent.length, 2);
        assert.equal(displayed[1], "Reply to thread: example.cs:L1-L2");
        assert(sent[1].includes("Please explain more"));
        assert(sent[1].includes(JSON.stringify(anchor.quote)));
        const resolved = await store.resolve(first.id, true, follow.revision);
        const lateReply = await store.agentReply(first.id, follow.messages.at(-1).id, "Additional explanation");
        assert.equal(lateReply.resolved, true, "Agent reply must not reopen a user-resolved thread");
        await assert.rejects(store.userReply(first.id, "No", lateReply.revision, "request-three"), /Reopen this comment/);
        const reloaded = await createReviewStore(path, async () => { throw new Error("must not send on reload"); });
        assert.deepEqual(reloaded.read(first.id), lateReply);
        assert.equal(reloaded.list().length, 1);
        const reopened = await reloaded.resolve(first.id, false, lateReply.revision);
        assert.equal(reopened.resolved, false);
        assert.equal(resolved.anchor.quote, "rst\nsecond");
        const copied = reloaded.list();
        copied[0].anchor.quote = "tampered";
        assert.equal(reloaded.read(first.id).anchor.quote, "rst\nsecond");
        assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncertain delivery is durable and never retried automatically", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-review-error-"));
    try {
        let sends = 0;
        let displayed;
        const store = await createReviewStore(join(root, "reviews.json"), async (_prompt, displayPrompt) => {
            sends++;
            displayed = displayPrompt;
            throw new Error("connection interrupted after admission");
        });
        const anchor = reviewAnchor(comparison, file, sources, { ...selection, endLine: 1, endColumn: 4 });
        const thread = await store.create(comparison, anchor, "Please fix", "request-error");
        assert.equal(displayed, "Review inline code: example.cs:L1");
        assert.equal(thread.messages[0].delivery.state, "uncertain");
        assert.match(thread.messages[0].delivery.error, /interrupted/);
        await store.create(comparison, anchor, "Please fix", "request-error");
        assert.equal(sends, 1);
        await assert.rejects(store.agentReply(thread.id, "unknown", "Invalid"), /reference/);
        await assert.rejects(store.create(comparison, anchor, "different", "request-error"), /reused/);
        await assert.rejects(store.create(comparison, anchor, " ", "empty-body"), /must not be empty/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
