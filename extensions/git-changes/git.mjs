import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, normalize } from "node:path";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const MAX_OUTPUT = 24 * 1024 * 1024;

export async function git(repo, args, maxBuffer = MAX_OUTPUT, input = "") {
    try {
        let inputError;
        const operation = execute("git", [
            "--no-pager", "--literal-pathspecs", "-c", "core.quotepath=false", ...args,
        ], {
            cwd: repo, windowsHide: true, encoding: "utf8", maxBuffer, timeout: 60000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
        });
        operation.child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE" && error.code !== "EOF") {
                inputError = error;
                operation.child.kill();
            }
        });
        operation.child.stdin.end(input);
        const { stdout } = await operation;
        if (inputError) throw inputError;
        return stdout;
    } catch (error) {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            throw new Error("Git output exceeds 24 MiB. Narrow this comparison or inspect this file in a local IDE.");
        }
        if (error.killed) throw new Error("Git timed out after 60 seconds. Try a narrower comparison.");
        const failure = new Error((error.stderr || error.message).trim());
        failure.exitCode = error.code;
        throw failure;
    }
}

export async function repository(repo) {
    if (typeof repo !== "string" || !isAbsolute(repo) || repo.includes("\0")) {
        throw new Error("Enter an absolute local repository path.");
    }
    const root = normalize((await git(repo, ["rev-parse", "--show-toplevel"])).trim());
    const output = await git(root, ["for-each-ref", "--format=%(refname)%00%(symref)%00%(upstream:short)", "refs/heads", "refs/remotes"]);
    const records = output.trimEnd().split("\n").filter(Boolean).map((line) => line.replace(/\r$/, "").split("\0"));
    const refs = records.filter(([, symref]) => !symref).map(([ref]) => ref.replace(/^refs\/(heads|remotes)\//, ""));
    const originHead = records.find(([ref]) => ref === "refs/remotes/origin/HEAD")?.[1];
    let headRef;
    try {
        headRef = (await git(root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    } catch (error) {
        // Exit 1 means detached HEAD; other Git failures must remain visible.
        if (error.exitCode !== 1) throw error;
    }
    const head = headRef?.replace(/^refs\/heads\//, "") ?? "HEAD";
    const unborn = !!headRef && !records.some(([ref]) => ref === headRef);
    const remoteHeads = records.filter(([ref, symref]) => ref.startsWith("refs/remotes/") && symref);
    const defaultRef = originHead || (remoteHeads.length === 1 ? remoteHeads[0][1] : undefined);
    const upstream = records.find(([ref]) => ref === `refs/heads/${head}`)?.[2];
    return {
        repo: root, refs, head, unborn,
        defaultBase: defaultRef?.replace(/^refs\/remotes\//, "") || upstream || "HEAD",
        baseSource: defaultRef ? "remote-default" : upstream ? "upstream" : "head",
    };
}

async function commit(repo, ref) {
    if (typeof ref !== "string" || !ref.trim() || ref.includes("\0") || ref.length > 1024) {
        throw new Error("Both comparison refs must be nonempty Git revisions.");
    }
    return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

export function parseFiles(names, stats) {
    const statEntries = stats.split("\0");
    const byPath = new Map();
    for (let i = 0; i < statEntries.length && statEntries[i]; i++) {
        const record = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(statEntries[i]);
        if (!record) throw new Error("Unexpected Git numstat output.");
        let path = record[3];
        if (!path) {
            i++;
            path = statEntries[++i];
        }
        byPath.set(path, {
            additions: record[1] === "-" ? null : Number(record[1]),
            deletions: record[2] === "-" ? null : Number(record[2]),
            binary: record[1] === "-",
        });
    }
    const entries = names.split("\0");
    const files = [];
    for (let i = 0; i < entries.length && entries[i]; i++) {
        const status = entries[i];
        const first = entries[++i];
        const renamed = /^[RC]/.test(status);
        const path = renamed ? entries[++i] : first;
        if (path === undefined) throw new Error("Unexpected Git name-status output.");
        files.push({
            path, oldPath: renamed ? first : null, status,
            ...(byPath.get(path) ?? { additions: 0, deletions: 0, binary: false }),
        });
    }
    return files;
}

async function localChanges(repo, from, right) {
    // Raw, no-renames diff reads trees and object IDs, not missing file blobs.
    const raw = await git(repo, ["diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z", from, right, "--"]);
    const fields = raw.split("\0");
    const changes = [];
    for (let i = 0; i < fields.length && fields[i]; i += 2) {
        const header = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(fields[i]);
        if (!header || fields[i + 1] === undefined) throw new Error("Unexpected Git raw diff output.");
        changes.push({ path: fields[i + 1], status: header[5], objects: [
            { mode: header[1], id: header[3] }, { mode: header[2], id: header[4] },
        ] });
    }
    const ids = [...new Set(changes.flatMap((change) => change.objects.filter((object) => object.mode !== "160000" && !/^0+$/.test(object.id)).map((object) => object.id)))];
    const missing = new Set();
    if (ids.length) {
        const checks = await git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], MAX_OUTPUT, ids.join("\n") + "\n");
        for (const line of checks.trim().split(/\r?\n/)) {
            const [id, type] = line.split(" ");
            if (type === "missing") missing.add(id);
            else if (!["blob", "tree", "commit", "tag"].includes(type)) throw new Error(`Cannot inspect local Git object: ${line}`);
        }
    }
    const available = [];
    const skipped = [];
    for (const change of changes) {
        if (change.objects.some((object) => missing.has(object.id))) {
            skipped.push({ path: change.path, reason: "missing-local-object" });
        } else available.push(change);
    }
    return { available, skipped };
}

export async function compare(input) {
    const mode = input.mode ?? "merge-base";
    if (!["endpoints", "merge-base"].includes(mode)) throw new Error("Unknown comparison mode.");
    const info = await repository(input.repo);
    const [left, right] = await Promise.all([commit(info.repo, input.base), commit(info.repo, input.target)]);
    let from = left;
    if (mode === "merge-base") {
        let output;
        try {
            output = await git(info.repo, ["merge-base", "--all", left, right]);
        } catch (error) {
            if (error.exitCode === 1) throw new Error("These refs have no common ancestor. Use endpoint mode.");
            throw error;
        }
        const ancestors = output.trim().split(/\r?\n/).filter(Boolean);
        if (ancestors.length !== 1) {
            throw new Error(ancestors.length ? "Multiple merge bases found. Use endpoint mode to avoid an ambiguous diff." : "These refs have no common ancestor. Use endpoint mode.");
        }
        from = ancestors[0];
    }
    const { available, skipped } = await localChanges(info.repo, from, right);
    const files = [];
    // Bound path arguments below Windows' command-line limit.
    for (let i = 0; i < available.length;) {
        const batch = [];
        let length = 0;
        do {
            const change = available[i++];
            batch.push(change);
            length += change.path.length * 2 + 4;
        } while (i < available.length && length + available[i].path.length * 2 + 4 < 16000);
        const stats = await git(info.repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--numstat", "-z", from, right, "--", ...batch.map((change) => change.path)]);
        files.push(...parseFiles(batch.map((change) => `${change.status}\0${change.path}\0`).join(""), stats).map((file, index) => ({
            ...file, baseObject: batch[index].objects[0], targetObject: batch[index].objects[1],
        })));
    }
    return {
        id: createHash("sha256").update(JSON.stringify([info.repo, from, right, mode, left, files.map((file) => file.path), skipped])).digest("hex"),
        repo: info.repo, base: input.base, target: input.target, mode,
        left, from, right, files, fileCount: files.length,
        scope: "local-objects", skipped,
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    };
}

export function parsePatch(patch) {
    const hunks = [];
    const metadata = [];
    let hunk;
    let oldLine = 0;
    let newLine = 0;
    const lines = patch.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const raw of lines) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            hunk = {
                header: raw, oldStart: oldLine, newStart: newLine,
                oldCount: Number(header[2] ?? 1), newCount: Number(header[4] ?? 1), lines: [],
            };
            hunks.push(hunk);
        } else if (hunk && /^[ +\-\\]/.test(raw)) {
            const type = { "+": "add", "-": "delete", " ": "context", "\\": "note" }[raw[0]];
            hunk.lines.push({
                type, text: raw.slice(1),
                oldLine: ["context", "delete"].includes(type) ? oldLine++ : null,
                newLine: ["context", "add"].includes(type) ? newLine++ : null,
            });
        } else {
            metadata.push(raw);
        }
    }
    return { metadata, hunks };
}

export async function fileDiff(comparison, path) {
    const entry = comparison.files.find((file) => file.path === path);
    if (!entry) throw new Error("That file is not part of this comparison. Refresh the comparison.");
    const patch = await git(comparison.repo, [
        "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
        "--ignore-submodules=none", "--submodule=short", "--unified=3",
        comparison.from, comparison.right, "--", ...new Set([entry.oldPath, entry.path].filter(Boolean)),
    ]);
    return { ...entry, comparisonId: comparison.id, ...parsePatch(patch) };
}

export async function fileSources(comparison, path) {
    const entry = comparison.files.find((file) => file.path === path);
    if (!entry) throw new Error("That file is not part of this comparison. Refresh the comparison.");
    if (entry.binary) return { base: null, target: null, unavailableReason: "Binary files have no full-text view." };
    if ([entry.baseObject, entry.targetObject].some((object) => object.mode === "160000")) {
        return { base: null, target: null, unavailableReason: "Submodule entries have no full-text file view." };
    }
    async function read(object, revision) {
        if (/^0+$/.test(object.id)) return null;
        const size = Number((await git(comparison.repo, ["cat-file", "-s", object.id])).trim());
        if (size > MAX_OUTPUT) return { revision, text: null, unavailableReason: "This file exceeds 24 MiB and cannot be loaded in full in the panel." };
        const text = await git(comparison.repo, ["cat-file", "blob", object.id]);
        return { revision, text };
    }
    const [base, target] = await Promise.all([
        read(entry.baseObject, comparison.from), read(entry.targetObject, comparison.right),
    ]);
    return { base, target, unavailableReason: null };
}
