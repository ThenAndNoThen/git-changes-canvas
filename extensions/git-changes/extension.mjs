import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createPanel } from "./server.mjs";
import { createReviewStore } from "./reviews.mjs";
import { join } from "node:path";

const servers = new Map();
let session;
let reviewStore;
async function reviews() {
    if (!session?.workspacePath) throw new Error("This session has no persistent storage directory. Review comments cannot be saved.");
    reviewStore ??= createReviewStore(join(session.workspacePath, "files", "git-changes-reviews.json"), (prompt, displayPrompt) =>
        session.send({ prompt, displayPrompt, mode: "enqueue", source: "user" }));
    return reviewStore;
}

async function reviewTool(handler) {
    try {
        return { resultType: "success", textResultForLlm: JSON.stringify(await handler()) };
    } catch (error) {
        return { resultType: "failure", textResultForLlm: error.message };
    }
}
const comparisonProperties = {
    repo: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["merge-base", "endpoints"] },
};

function panel(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) throw new CanvasError("panel_not_open", "Open Git Changes first.");
    return entry;
}

session = await joinSession({
    tools: [
        {
            name: "git_changes_review_read",
            description: "Read a Git Changes review thread in this session, including its pinned code range and user/agent conversation.",
            parameters: { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"], additionalProperties: false },
            handler: (input) => reviewTool(async () => (await reviews()).read(input.threadId)),
        },
        {
            name: "git_changes_review_reply",
            description: "Post the main agent's response to a user review comment in Git Changes. Use after handling the request or explaining a blocker. Never resolves the thread; only the user decides to resolve.",
            parameters: {
                type: "object", additionalProperties: false,
                properties: { threadId: { type: "string" }, replyTo: { type: "string" }, body: { type: "string", minLength: 1, maxLength: 10000 } },
                required: ["threadId", "replyTo", "body"],
            },
            handler: (input) => reviewTool(async () => (await reviews()).agentReply(input.threadId, input.replyTo, input.body)),
        },
    ],
    canvases: [createCanvas({
        id: "git-changes",
        displayName: "Git Changes",
        description: "Read-only branch diff using local Git objects, including un-checked-out files, with side-by-side views and no downloads.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: comparisonProperties,
        },
        actions: [
            {
                name: "compare",
                description: "Compare two local Git refs; merge-base mode is git diff A...B, endpoints is git diff A B. Does not fetch or modify the repository.",
                inputSchema: {
                    type: "object", additionalProperties: false,
                    properties: comparisonProperties, required: ["repo", "base", "target"],
                },
                handler: async (ctx) => {
                    const result = await panel(ctx.instanceId).compare(ctx.input);
                    return { ...result, files: result.files.slice(0, 30), filesShown: Math.min(result.files.length, 30), skipped: result.skipped.slice(0, 30), skippedFileCount: result.skipped.length };
                },
            },
            {
                name: "get_state",
                description: "Get the current comparison and file counts without returning the full diff.",
                inputSchema: { type: "object", additionalProperties: false },
                handler: (ctx) => panel(ctx.instanceId).summary(),
            },
            {
                name: "get_file",
                description: "Get a changed file's parsed diff; optionally include complete local Git source text for both compared versions.",
                inputSchema: {
                    type: "object", additionalProperties: false,
                    properties: { path: { type: "string", minLength: 1 }, includeSources: { type: "boolean" } }, required: ["path"],
                },
                handler: (ctx) => panel(ctx.instanceId).file(ctx.input.path, undefined, ctx.input.includeSources === true),
            },
        ],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await createPanel(ctx.input ?? {}, undefined, {
                    workingDirectory: ctx.session?.workingDirectory ?? process.cwd(),
                    reviews: await reviews(),
                });
                servers.set(ctx.instanceId, entry);
            }
            return { title: "Git Changes", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await entry.close();
            }
        },
    })],
});
