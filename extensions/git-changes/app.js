import { fullFileChanges, fullFileSections, groups, splitRows, wordRange } from "./diff-model.mjs";
import { appendCode, highlightLines, sourceLines } from "./syntax.mjs";
import { createReviewUI } from "./review-ui.mjs";

const $ = (id) => document.getElementById(id);
let comparison = null;
let currentFile = null;
let selectedPath = "";
let visibleFiles = [];
let anchors = [];
let active = -1;
let fileRequest = 0;
let repoRequest = 0;
let comparing = false;
let navigating = false;
let persistTimer;
let coloring = { left: null, right: null };

const isFullFile = () => $("full-file").getAttribute("aria-pressed") === "true";

function setFullFile(value) {
    $("full-file").setAttribute("aria-pressed", String(value));
    $("full-file").textContent = value ? "Back to diff" : "Full file";
    $("view").querySelector('[value="unified"]').textContent = value ? "Single column" : "Unified";
    $("position").hidden = false;
    $("view-hint").textContent = "F7 next · Shift+F7 previous · Navigates across files";
}

function prepareHighlighting() {
    for (const [side, key] of [["left", "base"], ["right", "target"]]) {
        const source = currentFile?.sources?.[key];
        coloring[side] = typeof source?.text === "string" ? highlightLines(source.text, currentFile.path) : null;
    }
}

function syntaxDescription() {
    const values = [coloring.left, coloring.right].filter(Boolean);
    return [...new Set(values.flatMap((value) => [value.language, value.notice]).filter(Boolean))].join(" · ");
}

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function showError(error) {
    $("error").textContent = error?.message ?? String(error);
    $("error").hidden = false;
    $("status").textContent = "Operation failed";
}

function clearError() { $("error").hidden = true; }

async function request(route, data) {
    const response = await fetch(route, data === undefined ? { credentials: "omit" } : {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "X-Git-Changes": "1" },
        body: JSON.stringify(data),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
}

function empty(title, detail) {
    const box = node("div", "empty");
    box.append(node("div", "empty-icon", "⇄"), node("h2", "", title), node("p", "", detail));
    $("diff").replaceChildren(box);
    $("pane-labels").hidden = true;
    $("horizontal").hidden = true;
}

function updateModeHint() {
    $("mode").title = $("mode").value === "merge-base"
        ? "Compare the common ancestor of A and B with B, excluding changes unique to A. Direction matters."
        : "Compare the complete file trees of commits A and B.";
}

function remember() {
    clearTimeout(persistTimer);
    if (!comparison) return;
    const values = {
        comparisonId: comparison.id, selectedPath,
        view: $("view").value, wrap: $("wrap").getAttribute("aria-pressed") === "true",
        fullFile: isFullFile(),
    };
    persistTimer = setTimeout(() => request("preferences", values).catch(showError), 200);
}

function navigationState() {
    const index = visibleFiles.findIndex((file) => file.path === selectedPath);
    const busy = comparing || navigating || !currentFile;
    $("full-file").disabled = !currentFile;
    $("prev").disabled = busy || (active <= 0 && index <= 0);
    $("next").disabled = busy || (active >= anchors.length - 1 && index >= visibleFiles.length - 1);
    $("position").textContent = `${active < 0 ? 0 : active + 1} / ${anchors.length}`;
}

function renderFiles() {
    const query = $("filter").value.trim().toLocaleLowerCase();
    visibleFiles = (comparison?.files ?? []).filter((file) => `${file.path}\n${file.oldPath ?? ""}`.toLocaleLowerCase().includes(query));
    $("file-count").textContent = query ? `${visibleFiles.length} / ${comparison.files.length}` : String(visibleFiles.length);
    const fragment = document.createDocumentFragment();
    for (const file of visibleFiles) {
        const button = node("button", "file");
        button.type = "button";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(file.path === selectedPath));
        button.dataset.path = file.path;
        button.title = `${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
        const names = node("span", "file-names");
        const parts = file.path.split("/");
        names.append(node("div", "file-name", parts.pop()), node("div", "file-path", file.oldPath ? `${file.oldPath} →` : (parts.join("/") || "Repository root")));
        const stat = node("span", "file-stat");
        if (file.binary) stat.textContent = "binary";
        else {
            if (file.additions > 0) stat.append(node("span", "plus", `+${file.additions}`));
            if (file.deletions > 0) {
                if (stat.childNodes.length) stat.append(document.createTextNode(" "));
                stat.append(node("span", "minus", `−${file.deletions}`));
            }
        }
        button.append(node("span", `file-status ${file.status[0]}`, file.status[0]), names);
        if (stat.hasChildNodes()) button.append(stat);
        button.addEventListener("click", () => selectFile(file.path).catch(showError));
        fragment.append(button);
    }
    if (!visibleFiles.length) fragment.append(node("div", "file-empty", query ? "No matching files" : comparison ? "No changes between these versions" : "Compare to see changed files"));
    $("files").replaceChildren(fragment);
    navigationState();
}

function contentCell(line, side, range, syntaxSide = side) {
    const cell = node("td", `code ${side} ${line?.type ?? "blank"}`);
    const text = node("span", "code-text");
    const value = (line?.text ?? "").replace(/\r$/, "");
    const number = syntaxSide === "left" ? line?.oldLine : line?.newLine;
    const tokens = number == null ? undefined : coloring[syntaxSide]?.lines[number - 1];
    if (number != null) {
        cell.dataset.sourceSide = syntaxSide === "left" ? "base" : "target";
        cell.dataset.line = String(number);
    }
    appendCode(text, value, tokens, range);
    cell.append(text);
    return cell;
}

function numberCell(value, type) { return node("td", `number ${type ?? ""}`, value == null ? "" : String(value)); }

function splitRow({ left, right }) {
    const row = node("tr");
    let ranges;
    if (left?.type === "delete" && right?.type === "add") ranges = wordRange(left.text, right.text);
    row.append(
        numberCell(left?.oldLine, left?.type),
        contentCell(left, "left", ranges && [ranges.start, ranges.endLeft]),
        numberCell(right?.newLine, right?.type),
        contentCell(right, "right", ranges && [ranges.start, ranges.endRight]),
    );
    return row;
}

function unifiedRow(line) {
    const row = node("tr");
    row.append(numberCell(line.oldLine, line.type), numberCell(line.newLine, line.type),
        node("td", `sign ${line.type}`, { add: "+", delete: "−", context: " ", note: "\\" }[line.type]),
        contentCell(line, "left", undefined, line.type === "delete" ? "left" : "right"));
    return row;
}

function renderDiff() {
    anchors = [];
    active = -1;
    $("diff").style.setProperty("--scroll-left", "0px");
    $("diff").style.setProperty("--scroll-right", "0px");
    if (!currentFile) return navigationState();
    $("pane-labels").classList.remove("full");
    $("right-label").hidden = false;
    const unified = $("view").value === "unified";
    $("pane-labels").hidden = unified;
    $("left-label").textContent = `${comparison.mode === "merge-base" ? "Common ancestor" : comparison.base} · ${comparison.from.slice(0, 10)}`;
    $("right-label").textContent = `${comparison.target} · ${comparison.right.slice(0, 10)}`;
    const fragment = document.createDocumentFragment();
    const metadata = currentFile.metadata.filter((line) => !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ "));
    if (metadata.length) fragment.append(node("div", "metadata", metadata.join("\n")));
    for (const hunk of currentFile.hunks) {
        const section = node("section", "hunk");
        section.append(node("div", "hunk-header", hunk.header));
        const table = node("table", "diff-table");
        const colgroup = node("colgroup");
        for (const type of unified ? ["number", "number", "sign", ""] : ["number", "", "number", ""]) {
            colgroup.append(node("col", type));
        }
        table.append(colgroup);
        for (const group of groups(hunk.lines)) {
            const body = node("tbody", group.changed ? "change-anchor" : "");
            if (group.changed) anchors.push(body);
            for (const line of unified ? group.lines : splitRows(group.lines)) {
                body.append(unified ? unifiedRow(line) : splitRow(line));
            }
            table.append(body);
        }
        section.append(table);
        fragment.append(section);
    }
    $("diff").replaceChildren(fragment);
    if (!currentFile.hunks.length) {
        const info = node("div", "empty");
        info.append(node("h2", "", currentFile.binary ? "Binary file" : "File metadata changed"), node("p", "", currentFile.binary ? "Binary content changed. Git cannot display a text diff." : "No text differences. This may be a rename, a permission change, or an added or deleted empty file."));
        $("diff").append(info);
    }
    $("diff").scrollTop = 0;
    $("status").textContent = `${currentFile.status} · ${anchors.length} changes${currentFile.binary ? " · binary" : ` · +${currentFile.additions} −${currentFile.deletions}`} · ${syntaxDescription()}`;
    const unavailable = [currentFile.sources?.base, currentFile.sources?.target].find((source) => source?.unavailableReason);
    if (unavailable) $("status").textContent += ` · ${unavailable.unavailableReason}`;
    navigationState();
    requestAnimationFrame(horizontalWidths);
}

function renderFullFile() {
    anchors = [];
    active = -1;
    navigationState();
    const target = currentFile?.sources?.target;
    const base = currentFile?.sources?.base;
    const source = target ?? base;
    const split = $("view").value === "split";
    const unavailable = split ? [base, target].find((item) => item?.text === null) : source?.text === null ? source : null;
    if (!source || unavailable) {
        const reason = unavailable?.unavailableReason || currentFile?.sources?.unavailableReason || "No text file is available for this version.";
        empty("Full file unavailable", reason);
        $("status").textContent = reason;
        return;
    }
    if (split) {
        renderFullSplit(base, target);
        return;
    }
    const side = target ? "right" : "left";
    const label = target ? `Target B · ${comparison.target}` : `${currentFile.status === "D" ? "Deleted file · " : ""}${comparison.mode === "merge-base" ? "Common ancestor" : "Base A"}`;
    $("pane-labels").hidden = false;
    $("pane-labels").classList.add("full");
    $("right-label").hidden = true;
    $("left-label").textContent = `${label} · ${source.revision.slice(0, 10)} · Full file`;
    const table = node("table", "diff-table full-table");
    const colgroup = node("colgroup");
    colgroup.append(node("col", "number"), node("col"));
    table.append(colgroup);
    const lines = sourceLines(source.text);
    let nextLine = 1;
    function appendLines(end, change) {
        if (nextLine > end) return;
        const body = node("tbody", change ? "change-anchor" : "");
        if (change) {
            body.dataset.line = String(change.start);
            anchors.push(body);
        }
        while (nextLine <= end) {
            const type = change?.type ?? "context";
            const row = node("tr", "source-line");
            row.dataset.line = String(nextLine);
            const line = { type, text: lines[nextLine - 1], oldLine: nextLine, newLine: nextLine };
            row.append(numberCell(nextLine, type), contentCell(line, "left", undefined, side));
            body.append(row);
            nextLine++;
        }
        table.append(body);
    }
    for (const change of fullFileChanges(currentFile.hunks, side)) {
        appendLines(change.start - 1);
        if (change.marker) {
            const body = node("tbody", "change-anchor");
            body.dataset.line = String(change.start);
            const row = node("tr");
            const cell = node("td", `full-change-marker ${change.type}`, `${change.hiddenLines} lines ${change.type === "delete" ? "deleted" : "added"} here · Switch to diff to view content`);
            cell.colSpan = 2;
            row.append(cell);
            body.append(row);
            anchors.push(body);
            table.append(body);
        } else appendLines(change.end, change);
    }
    appendLines(lines.length);
    $("diff").replaceChildren(table);
    if (!lines.length && !anchors.length) $("diff").append(node("div", "empty", "Empty file"));
    $("diff").scrollTop = 0;
    $("left-scroll").scrollLeft = 0;
    $("right-scroll").scrollLeft = 0;
    $("status").textContent = `Full file · ${lines.length} lines · ${anchors.length} changes · ${coloring[side]?.language ?? "Plain text"}${coloring[side]?.notice ? ` · ${coloring[side].notice}` : ""}`;
    navigationState();
    requestAnimationFrame(horizontalWidths);
}

function renderFullSplit(base, target) {
    const leftLines = sourceLines(base?.text ?? "");
    const rightLines = sourceLines(target?.text ?? "");
    $("pane-labels").hidden = false;
    $("pane-labels").classList.remove("full");
    $("right-label").hidden = false;
    $("left-label").textContent = `${comparison.mode === "merge-base" ? "Common ancestor" : comparison.base} · ${comparison.from.slice(0, 10)} · ${base ? "Full file" : "File does not exist"}`;
    $("right-label").textContent = `${comparison.target} · ${comparison.right.slice(0, 10)} · ${target ? "Full file" : "File deleted"}`;
    const table = node("table", "diff-table full-table full-split");
    const colgroup = node("colgroup");
    for (const type of ["number", "", "number", ""]) colgroup.append(node("col", type));
    table.append(colgroup);
    for (const section of fullFileSections(leftLines, rightLines, currentFile.hunks)) {
        const body = node("tbody", section.changed ? "change-anchor" : "");
        if (section.changed) {
            body.dataset.line = String(section.start);
            body.dataset.oldLine = String(section.oldStart);
            anchors.push(body);
        }
        for (const pair of section.rows) body.append(splitRow(pair));
        table.append(body);
    }
    $("diff").replaceChildren(table);
    if (!leftLines.length && !rightLines.length) $("diff").append(node("div", "empty", "Empty file"));
    $("diff").scrollTop = 0;
    $("left-scroll").scrollLeft = 0;
    $("right-scroll").scrollLeft = 0;
    $("status").textContent = `Full file split · Left ${leftLines.length} lines / Right ${rightLines.length} lines · ${anchors.length} changes · ${syntaxDescription()}`;
    navigationState();
    requestAnimationFrame(horizontalWidths);
}

function renderCurrent() {
    if (isFullFile()) renderFullFile();
    else renderDiff();
    reviews.annotate();
}

function horizontalWidths() {
    const unified = $("view").value === "unified";
    const wrap = $("wrap").getAttribute("aria-pressed") === "true";
    $("horizontal").hidden = wrap || !$("diff").querySelector(".code-text");
    $("horizontal").classList.toggle("unified", unified);
    $("right-scroll").hidden = unified;
    for (const side of ["left", "right"]) {
        const rail = $(`${side}-scroll`);
        let overflow = 0;
        for (const text of $("diff").querySelectorAll(`.code.${side} .code-text`)) {
            overflow = Math.max(overflow, text.scrollWidth - (text.parentElement.clientWidth - 16));
        }
        rail.firstElementChild.style.width = `${rail.clientWidth + Math.max(0, overflow)}px`;
        $("diff").style.setProperty(`--scroll-${side}`, `${rail.scrollLeft}px`);
    }
}

function activate(index, scroll = true) {
    anchors[active]?.classList.remove("active");
    active = Math.max(0, Math.min(index, anchors.length - 1));
    if (!anchors.length) active = -1;
    const anchor = anchors[active];
    if (anchor) {
        anchor.classList.add("active");
        if (scroll) {
            const top = anchor.getBoundingClientRect().top - $("diff").getBoundingClientRect().top + $("diff").scrollTop;
            $("diff").scrollTo({ top: Math.max(0, top - 40), behavior: "instant" });
        }
    }
    navigationState();
}

async function selectFile(path, edge = "first") {
    if (!comparison) return;
    const version = ++fileRequest;
    const id = comparison.id;
    currentFile = null;
    selectedPath = path;
    anchors = [];
    active = -1;
    $("filename").textContent = path;
    $("filename").title = path;
    $("status").textContent = "Reading diff…";
    renderFiles();
    empty("Loading…", path);
    try {
        const result = await request("file", { path, comparisonId: id, includeSources: true });
        if (version !== fileRequest || id !== comparison?.id) return;
        currentFile = result;
        prepareHighlighting();
        renderCurrent();
        activate(edge === "last" ? anchors.length - 1 : 0);
        remember();
        $("files").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    } catch (error) {
        if (version !== fileRequest) return;
        empty("Unable to read this file", error.message);
        throw error;
    }
}

async function navigate(direction) {
    if (comparing || navigating || !currentFile) return;
    clearError();
    const next = active + direction;
    if (next >= 0 && next < anchors.length) return activate(next);
    const index = visibleFiles.findIndex((file) => file.path === selectedPath);
    const destination = index + direction;
    if (destination < 0 || destination >= visibleFiles.length) return;
    navigating = true;
    navigationState();
    try {
        await selectFile(visibleFiles[destination].path, direction < 0 ? "last" : "first");
    } finally {
        navigating = false;
        navigationState();
    }
}

async function applyComparison(value) {
    const changed = comparison?.id !== value.id;
    comparison = value;
    $("summary").textContent = `${value.fileCount} files  ·  +${value.additions}  −${value.deletions}`;
    $("scope-note").textContent = `Local Git objects only · Includes files not checked out, added and deleted files · Skipped ${value.skipped.length} files with missing history (no downloads)`;
    $("scope-note").title = value.skipped.slice(0, 30).map((file) => file.path).join("\n");
    renderFiles();
    const path = visibleFiles.find((file) => file.path === selectedPath)?.path ?? visibleFiles[0]?.path;
    if (!path) {
        ++fileRequest;
        selectedPath = "";
        currentFile = null;
        anchors = [];
        active = -1;
        $("filename").textContent = "No changes";
        const explanation = value.skipped.length
            ? `${value.skipped.length} files were skipped because required local history is missing. Nothing was downloaded; skipped files may still contain changes.`
            : value.mode === "merge-base" && value.from === value.right && value.left !== value.right
            ? "Target B has no changes since divergence. A...B only shows B's changes; swap A and B to see changes unique to A."
            : "No committed changes in this comparison. Uncommitted changes are not included.";
        empty(value.skipped.length ? "Required local objects are missing" : "No changes to display", $("filter").value ? "Clear the file filter to see all changes." : explanation);
        $("status").textContent = "Comparison complete";
        navigationState();
    } else if (changed || !currentFile || selectedPath !== path) await selectFile(path);
    await reviews.refresh();
}

async function loadRepository(restore = true) {
    const version = ++repoRequest;
    const repo = $("repo").value.trim();
    $("status").textContent = "Loading branches…";
    const info = await request("repository", { repo });
    if (version !== repoRequest || $("repo").value.trim() !== repo) return false;
    $("repo").value = info.repo;
    const options = document.createDocumentFragment();
    for (const ref of new Set(["HEAD", info.head, ...info.refs])) {
        const option = node("option"); option.value = ref; options.append(option);
    }
    $("refs").replaceChildren(options);
    if (restore || !$("base").value) $("base").value = info.defaultBase;
    if (restore || !$("target").value) $("target").value = info.head;
    if (restore) {
        $("mode").value = "merge-base";
        $("view").value = info.saved.view || "split";
        $("wrap").setAttribute("aria-pressed", String(info.saved.wrap ?? false));
        setFullFile(info.saved.fullFile ?? false);
        $("diff").classList.toggle("wrap", info.saved.wrap ?? false);
        selectedPath = info.saved.selectedPath || "";
    }
    updateModeHint();
    $("status").textContent = info.baseSource === "head"
        ? "No remote default branch or upstream configured; using HEAD as the base. Only committed changes are compared."
        : `${info.refs.length} local / remote branches (no automatic fetch)`;
    return info;
}

async function runCompare() {
    if (comparing) return;
    clearError();
    comparing = true;
    $("compare").disabled = true;
    $("compare").textContent = "Comparing…";
    $("status").textContent = "Comparing local Git objects… (missing objects will not be downloaded)";
    navigationState();
    try {
        const result = await request("compare", {
            repo: $("repo").value.trim(), base: $("base").value.trim(),
            target: $("target").value.trim(), mode: $("mode").value,
        });
        await applyComparison(result);
        const option = node("option"); option.value = result.repo;
        if (![...$("repositories").options].some((item) => item.value === result.repo)) $("repositories").append(option);
    } finally {
        comparing = false;
        $("compare").disabled = false;
        $("compare").textContent = "Compare / Refresh";
        navigationState();
    }
}

function submitComparison() {
    for (const id of ["repo", "base", "target"]) if (!$(id).reportValidity()) return;
    runCompare().catch(showError);
}
$("compare").addEventListener("click", submitComparison);
$("compare-form").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") {
        event.preventDefault();
        submitComparison();
    }
});
$("load-repo").addEventListener("click", () => { clearError(); loadRepository().catch(showError); });
$("repo").addEventListener("change", () => { clearError(); loadRepository().catch(showError); });
for (const id of ["base", "target", "mode"]) $(id).addEventListener("input", () => {
    updateModeHint();
    $("status").textContent = "Parameters changed. Click Compare / Refresh to apply; the previous result is still displayed.";
});
$("swap").addEventListener("click", () => {
    const base = $("base").value;
    $("base").value = $("target").value;
    $("target").value = base;
    $("status").textContent = "A and B swapped. Click Compare / Refresh to apply.";
});
$("filter").addEventListener("input", renderFiles);
$("view").addEventListener("change", () => { const previous = active; renderCurrent(); activate(previous); remember(); });
$("full-file").addEventListener("click", () => {
    if (!currentFile) return;
    const previous = active;
    setFullFile(!isFullFile());
    renderCurrent();
    activate(previous);
    remember();
});
$("wrap").addEventListener("click", () => {
    const wrap = $("wrap").getAttribute("aria-pressed") !== "true";
    $("wrap").setAttribute("aria-pressed", String(wrap));
    $("diff").classList.toggle("wrap", wrap);
    horizontalWidths();
    remember();
});
$("prev").addEventListener("click", () => navigate(-1).catch(showError));
$("next").addEventListener("click", () => navigate(1).catch(showError));
document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault(); $("filter").focus(); return;
    }
    if (typing) return;
    if (event.key === "F7" || (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key))) {
        event.preventDefault();
        navigate(event.shiftKey || event.key === "ArrowUp" ? -1 : 1).catch(showError);
    }
});
$("files").addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.altKey) return;
    event.preventDefault();
    const index = visibleFiles.findIndex((file) => file.path === selectedPath);
    const destination = visibleFiles[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (destination) selectFile(destination.path).catch(showError);
});
$("diff").addEventListener("click", (event) => {
    const index = anchors.indexOf(event.target.closest(".change-anchor"));
    if (index >= 0) activate(index, false);
});
let scrollFrame = 0;
$("diff").addEventListener("scroll", () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
        if (!anchors.length) return;
        const viewport = $("diff").getBoundingClientRect();
        const selected = anchors[active]?.getBoundingClientRect();
        if (selected && selected.top >= viewport.top && selected.bottom <= viewport.bottom) return;
        const top = viewport.top + 45;
        let closest = 0;
        for (let i = 0; i < anchors.length; i++) {
            if (anchors[i].getBoundingClientRect().top <= top) closest = i;
            else break;
        }
        if (closest !== active) activate(closest, false);
    });
}, { passive: true });
for (const side of ["left", "right"]) $(`${side}-scroll`).addEventListener("scroll", () => {
    $("diff").style.setProperty(`--scroll-${side}`, `${$(`${side}-scroll`).scrollLeft}px`);
}, { passive: true });
const aside = document.querySelector("aside");
$("resize").addEventListener("pointerdown", (event) => {
    $("resize").setPointerCapture(event.pointerId);
    event.preventDefault();
});
$("resize").addEventListener("pointermove", (event) => {
    if ($("resize").hasPointerCapture(event.pointerId)) {
        aside.style.width = `${Math.max(130, Math.min(window.innerWidth * .55, event.clientX))}px`;
    }
});
$("resize").addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        aside.style.width = `${aside.clientWidth + (event.key === "ArrowLeft" ? -20 : 20)}px`;
    }
});
new ResizeObserver(horizontalWidths).observe($("diff"));

const reviews = createReviewUI({
    request, showError,
    getState: () => ({ comparison, currentFile }),
    openAnchor: async (anchor) => {
        $("filter").value = "";
        setFullFile(true);
        $("view").value = "split";
        if (currentFile?.path !== anchor.path) await selectFile(anchor.path);
        else renderCurrent();
        remember();
    },
});

async function boot() {
    const state = await request("state");
    for (const repo of state.repositories) {
        const option = node("option"); option.value = repo; $("repositories").append(option);
    }
    const settings = state.settings;
    $("repo").value = settings.repo || "";
    if (!settings.repo) {
        $("status").textContent = "No repository is associated with this conversation. Open this canvas in a repository session to detect it automatically.";
        return;
    }
    const info = await loadRepository();
    if (!info) return;
    for (const key of ["base", "target", "mode", "view"]) if (settings[key]) $(key).value = settings[key];
    $("wrap").setAttribute("aria-pressed", String(settings.wrap ?? false));
    setFullFile(settings.fullFile ?? false);
    $("diff").classList.toggle("wrap", settings.wrap ?? false);
    selectedPath = settings.selectedPath || "";
    updateModeHint();
    if (state.comparison) await applyComparison(state.comparison);
    else if (info.unborn && [settings.base, settings.target].some((ref) => ref === "HEAD" || ref === info.head)) {
        $("filename").textContent = "No commits on this branch";
        $("status").textContent = "No commits to compare.";
        empty("No commits on this branch", "Create the first commit and click Compare / Refresh, or select other refs with existing commits.");
    } else await runCompare();
}

const events = new EventSource("events");
events.addEventListener("reviews", () => reviews.refresh().catch(showError));
events.onmessage = async () => {
    if (comparing) return;
    try {
        const state = await request("state");
        if (state.comparison && state.comparison.id !== comparison?.id) {
            for (const key of ["repo", "base", "target", "mode"]) $(key).value = state.settings[key];
            updateModeHint();
            await applyComparison(state.comparison);
        }
    } catch (error) { showError(error); }
};
events.onerror = () => { $("status").textContent = "Disconnected, reconnecting…"; };
events.onopen = () => { if ($("status").textContent.startsWith("Disconnected")) $("status").textContent = "Reconnected"; };
boot().catch(showError);
