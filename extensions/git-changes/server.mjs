import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { compare, fileDiff, fileSources, repository } from "./git.mjs";
import { reviewAnchor } from "./reviews.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const storage = join(directory, "artifacts", "preferences.json");
let writes = Promise.resolve();

async function preferences(storageFile = storage) {
    try {
        const value = JSON.parse(await readFile(storageFile, "utf8"));
        if (!value || typeof value !== "object" || !Array.isArray(value.repositories)) {
            throw new Error("Invalid saved Git Changes preferences.");
        }
        return value;
    } catch (error) {
        if (error.code === "ENOENT") return { repositories: [], lastRepo: "" };
        throw error;
    }
}

function save(repo, patch, storageFile = storage) {
    const pending = writes.then(async () => {
        const current = await preferences(storageFile);
        const previous = current.repositories.find((item) => item.repo === repo) ?? { repo };
        current.repositories = [{ ...previous, ...patch }, ...current.repositories.filter((item) => item.repo !== repo)].slice(0, 20);
        current.lastRepo = repo;
        await mkdir(dirname(storageFile), { recursive: true });
        const temporary = `${storageFile}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(current, null, 2), "utf8");
        await rename(temporary, storageFile);
    });
    // Keep later writes available; the failed operation still rejects for its caller.
    writes = pending.catch(() => {});
    return pending;
}

export async function initialSettings(input, saved, workingDirectory) {
    let info;
    let source = "none";
    if (input.repo) {
        info = await repository(input.repo);
        source = "input";
    } else if (workingDirectory) {
        try {
            info = await repository(workingDirectory);
            source = "workspace";
        } catch (error) {
            // A standalone chat has a scratch directory, not a Git worktree.
            if (!/^fatal: not a git repository/m.test(error.message)) throw error;
        }
    }
    if (!info && saved.lastRepo) {
        info = await repository(saved.lastRepo);
        source = "recent";
    }
    const stored = saved.repositories.find((item) => normalize(item.repo) === info?.repo);
    return {
        settings: info ? {
            repo: info.repo,
            base: input.base ?? info.defaultBase,
            target: input.target ?? info.head,
            mode: input.mode ?? "merge-base",
            view: stored?.view ?? "split",
            wrap: stored?.wrap ?? false,
            fullFile: stored?.fullFile ?? false,
            selectedPath: stored?.selectedPath ?? "",
        } : {},
        workspace: { workingDirectory, source, baseSource: info?.baseSource, head: info?.head },
    };
}

export async function createPanel(input, storageFile = storage, context = {}) {
    const saved = await preferences(storageFile);
    const initial = await initialSettings(input, saved, context.workingDirectory);
    let settings = initial.settings;
    const workspace = initial.workspace;
    let comparison = null;
    let generation = 0;
    const assets = new Map(await Promise.all(
        [["", "index.html", "text/html"], ["app.js", "app.js", "text/javascript"], ["review-ui.mjs", "review-ui.mjs", "text/javascript"], ["diff-model.mjs", "diff-model.mjs", "text/javascript"], ["syntax.mjs", "syntax.mjs", "text/javascript"], ["vendor/highlight.mjs", join("vendor", "highlight.mjs"), "text/javascript"], ["style.css", "style.css", "text/css"]]
            .map(async ([route, name, mime]) => [route, { body: await readFile(join(directory, name)), mime }]),
    ));
    const token = randomBytes(24).toString("hex");
    const prefix = `/${token}/`;
    const clients = new Set();
    const transport = { requests: 0, rejected: [] };
    let origin;

    function notify() {
        for (const client of clients) client.write("data: refresh\n\n");
    }
    const unsubscribe = context.reviews?.subscribe(() => {
        for (const client of clients) client.write("event: reviews\ndata: refresh\n\n");
    });

    function currentThreads() {
        if (!context.reviews || !comparison) return [];
        return context.reviews.list().filter((thread) =>
            thread.comparison.repo === comparison.repo && thread.comparison.base === comparison.base
            && thread.comparison.target === comparison.target && thread.comparison.mode === comparison.mode);
    }

    function threadInComparison(id) {
        const thread = currentThreads().find((entry) => entry.id === id);
        if (!thread) throw new Error("This comment does not belong to the current comparison.");
        return thread;
    }

    async function runComparison(values) {
        const revision = ++generation;
        const result = await compare(values);
        if (revision !== generation) throw new Error("Comparison superseded by a newer request.");
        const next = {
            ...settings, repo: result.repo, base: values.base, target: values.target, mode: result.mode,
            selectedPath: settings.repo === result.repo ? settings.selectedPath : "",
        };
        await save(result.repo, next, storageFile);
        if (revision !== generation) throw new Error("Comparison superseded by a newer request.");
        settings = next;
        comparison = result;
        notify();
        return result;
    }

    async function getFile(path, id, includeSources = false) {
        if (!comparison) throw new Error("Run a comparison first.");
        if (id && comparison.id !== id) throw new Error("This comparison changed. Reload the file.");
        const current = comparison;
        const result = await fileDiff(current, path);
        if (includeSources) result.sources = await fileSources(current, path);
        if (current !== comparison) throw new Error("This comparison changed. Reload the file.");
        return result;
    }

    async function body(req) {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 32768) throw new Error("Request is too large.");
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }

    function json(res, status, value) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(value));
    }

    const server = createServer(async (req, res) => {
        transport.requests++;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
        try {
            const pathname = new URL(req.url, origin).pathname;
            if (req.headers.host !== new URL(origin).host || !pathname.startsWith(prefix)) {
                return json(res, 404, { error: "Not found." });
            }
            if (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== "null") {
                transport.rejected.push({ method: req.method, origin: req.headers.origin, route: new URL(req.url, origin).pathname.split("/").at(-1) });
                transport.rejected = transport.rejected.slice(-5);
                return json(res, 403, { error: "Cross-origin requests are not allowed." });
            }
            // Sandboxed canvases have an opaque origin. The unguessable URL is
            // the capability; never expose CORS on routes outside that prefix.
            if (req.headers.origin === "null") {
                res.setHeader("Access-Control-Allow-Origin", "null");
                res.setHeader("Vary", "Origin");
            }
            if (req.method === "OPTIONS") {
                const method = req.headers["access-control-request-method"];
                const headers = (req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
                if (!["GET", "POST"].includes(method) || headers.some((header) => !["content-type", "x-git-changes"].includes(header))) {
                    return json(res, 403, { error: "Unsupported preflight request." });
                }
                res.setHeader("Access-Control-Allow-Methods", "GET, POST");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Git-Changes");
                res.writeHead(204);
                return res.end();
            }
            const route = pathname.slice(prefix.length);
            if (req.method === "GET" && assets.has(route)) {
                const asset = assets.get(route);
                res.writeHead(200, { "Content-Type": `${asset.mime}; charset=utf-8` });
                return res.end(asset.body);
            }
            if (req.method === "GET" && route === "events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
                res.write(": connected\n\n");
                clients.add(res);
                req.on("close", () => clients.delete(res));
                return;
            }
            if (req.method === "GET" && route === "state") {
                return json(res, 200, { settings, workspace, comparison, repositories: (await preferences(storageFile)).repositories.map((item) => item.repo) });
            }
            if (req.method === "GET" && route === "reviews") {
                return json(res, 200, { enabled: !!context.reviews, comparisonId: comparison?.id, threads: currentThreads() });
            }
            if (req.method !== "POST" || req.headers["x-git-changes"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) {
                return json(res, 405, { error: "Use a same-origin JSON POST." });
            }
            const data = await body(req);
            if (!data || typeof data !== "object") throw new Error("Expected an object.");
            if (route === "repository") {
                const info = await repository(data.repo);
                const stored = await preferences(storageFile);
                return json(res, 200, { ...info, saved: stored.repositories.find((item) => item.repo === info.repo) ?? {} });
            }
            if (route === "compare") return json(res, 200, await runComparison(data));
            if (route === "file") {
                if (data.includeSources !== undefined && typeof data.includeSources !== "boolean") throw new Error("Invalid source option.");
                return json(res, 200, await getFile(data.path, data.comparisonId, data.includeSources === true));
            }
            if (route.startsWith("reviews/")) {
                if (!context.reviews) throw new Error("This panel is not connected to the conversation's review service.");
                if (!comparison || data.comparisonId !== comparison.id) throw new Error("The comparison has changed. Refresh before commenting.");
                if (route === "reviews/create") {
                    const snapshot = comparison;
                    const file = snapshot.files.find((entry) => entry.path === data.path);
                    if (!file) throw new Error("This file does not belong to the current comparison.");
                    const sources = await fileSources(snapshot, file.path);
                    if (snapshot !== comparison) throw new Error("The comparison has changed. Select the code again.");
                    const anchor = reviewAnchor(snapshot, file, sources, data);
                    return json(res, 200, await context.reviews.create(snapshot, anchor, data.body, data.requestId));
                }
                threadInComparison(data.threadId);
                if (route === "reviews/reply") return json(res, 200, await context.reviews.userReply(data.threadId, data.body, data.revision, data.requestId));
                if (route === "reviews/resolve") return json(res, 200, await context.reviews.resolve(data.threadId, data.resolved, data.revision));
            }
            if (route === "preferences") {
                if (!comparison || data.comparisonId !== comparison.id) throw new Error("Comparison changed; preferences were not saved.");
                if (!["split", "unified"].includes(data.view)) throw new Error("Invalid view mode.");
                if (typeof data.wrap !== "boolean" || typeof data.selectedPath !== "string") throw new Error("Invalid view preferences.");
                if (data.fullFile !== undefined && typeof data.fullFile !== "boolean") throw new Error("Invalid full-file preference.");
                settings = { ...settings, view: data.view, wrap: data.wrap, fullFile: data.fullFile ?? settings.fullFile, selectedPath: data.selectedPath };
                await save(comparison.repo, settings, storageFile);
                return json(res, 200, { saved: true });
            }
            json(res, 404, { error: "Not found." });
        } catch (error) {
            json(res, 400, { error: error.message });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        url: `${origin}${prefix}`,
        compare: runComparison,
        file: getFile,
        summary: () => ({ settings, workspace, transport, comparison: comparison && { ...comparison, files: undefined, skipped: undefined, skippedFileCount: comparison.skipped.length } }),
        close: async () => {
            unsubscribe?.();
            for (const client of clients) client.end();
            server.closeIdleConnections();
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
