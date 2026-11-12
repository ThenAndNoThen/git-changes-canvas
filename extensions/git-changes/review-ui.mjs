export function createReviewUI({ request, getState, openAnchor, showError }) {
    const $ = (id) => document.getElementById(id);
    let enabled = false;
    let threads = [];
    let activeId = "";
    let selection;
    let firstLine;
    let posting = false;
    let createId;
    let refreshVersion = 0;
    const drafts = new Map();
    const expanded = new Set();
    const replyIds = new Map();
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function action(text, handler, className = "") {
        const button = element("button", className, text);
        button.type = "button";
        button.addEventListener("click", () => Promise.resolve().then(handler).catch(showError));
        return button;
    }
    const location = (anchor) => `${anchor.side === "base" ? "A" : "B"} · L${anchor.startLine}:${anchor.startColumn + 1}–L${anchor.endLine}:${anchor.endColumn + 1}`;
    function stale(thread) {
        const file = getState().comparison?.files.find((item) => item.path === thread.anchor.path);
        return (thread.anchor.side === "base" ? file?.baseObject : file?.targetObject)?.id !== thread.anchor.blob;
    }
    function stateLabel(thread) {
        if (thread.resolved) return "Resolved";
        const lastUser = thread.messages.filter((message) => message.author === "user").at(-1);
        if (thread.messages.some((message) => message.author === "agent" && message.replyTo === lastUser.id)) return "Agent replied · Awaiting your decision";
        return { pending: "Saved · Sending or awaiting confirmation", sent: "Sent to conversation · Awaiting reply", uncertain: "Delivery uncertain · Check the conversation before sending again" }[lastUser.delivery.state];
    }
    function currentSelection() {
        const state = getState();
        return selection?.comparisonId === state.comparison?.id && selection?.path === state.currentFile?.path;
    }
    function updateCommentButtons() {
        const state = getState();
        for (const button of $("diff").querySelectorAll(".line-comment")) {
            const number = button.parentElement;
            button.disabled = !enabled || posting || typeof state.currentFile?.sources?.[number.dataset.sourceSide]?.text !== "string";
            number.classList.toggle("selection-end", !!selection && currentSelection()
                && selection.side === number.dataset.sourceSide && selection.endLine === Number(number.dataset.line));
        }
    }
    function navigation() {
        const visible = threads.filter((thread) => !thread.resolved);
        const index = visible.findIndex((thread) => thread.id === activeId);
        $("comment-position").textContent = `${index + 1} / ${visible.length}`;
        $("comment-prev").disabled = posting || index <= 0;
        $("comment-next").disabled = posting || index >= visible.length - 1;
        $("review-toggle").textContent = `Comments ${visible.length}${threads.length > visible.length ? ` · Resolved ${threads.length - visible.length}` : ""}`;
        updateCommentButtons();
    }
    function dock() {
        $("review-panel").hidden = false;
        $("review-toggle").setAttribute("aria-expanded", "true");
    }
    function annotate() {
        const state = getState();
        for (const cell of $("diff").querySelectorAll(".code[data-source-side]")) {
            const previous = cell.previousElementSibling;
            const number = previous?.classList.contains("number") ? previous
                : cell.parentElement.querySelectorAll(".number")[cell.dataset.sourceSide === "base" ? 0 : 1];
            if (number?.classList.contains("number")) {
                number.dataset.sourceSide = cell.dataset.sourceSide;
                number.dataset.line = cell.dataset.line;
                number.tabIndex = 0;
                number.setAttribute("aria-label", `Select ${cell.dataset.sourceSide === "base" ? "A" : "B"} line ${cell.dataset.line}; Shift-click to select multiple lines`);
                if (!number.querySelector(".line-comment")) {
                    const label = element("span", "line-number", number.textContent);
                    const button = element("button", "line-comment", "+");
                    button.type = "button";
                    button.title = "Add comment";
                    button.setAttribute("aria-label", `Add comment on ${cell.dataset.sourceSide === "base" ? "A" : "B"} line ${cell.dataset.line}`);
                    number.replaceChildren(button, label);
                }
            }
            const matches = threads.filter((thread) => !thread.resolved && thread.anchor.path === state.currentFile?.path
                && !stale(thread) && thread.anchor.side === cell.dataset.sourceSide
                && Number(cell.dataset.line) >= thread.anchor.startLine && Number(cell.dataset.line) <= thread.anchor.endLine);
            cell.classList.toggle("review-highlight", matches.some((thread) => thread.id === activeId));
            number?.classList.toggle("has-review", matches.length > 0);
            if (number) number.title = matches.length ? `${matches.length} unresolved comments` : "Click to select this line; Shift-click to select multiple lines";
        }
        updateCommentButtons();
    }
    async function locate(thread) {
        activeId = thread.id;
        dock();
        if (!stale(thread)) await openAnchor(thread.anchor);
        render();
        const card = $("review-list").querySelector(`[data-thread="${thread.id}"]`);
        if (card && thread.resolved) { expanded.add(thread.id); card.open = true; }
        card?.scrollIntoView({ block: "nearest" });
        if (!stale(thread)) {
            const cell = $("diff").querySelector(`.code[data-source-side="${thread.anchor.side}"][data-line="${thread.anchor.startLine}"]`);
            cell?.scrollIntoView({ block: "center" });
        }
    }
    async function changeThread(thread, route, extra) {
        posting = true;
        navigation();
        try {
            await request(`reviews/${route}`, { comparisonId: getState().comparison.id, threadId: thread.id, revision: thread.revision, ...extra });
            await refresh();
        } finally { posting = false; navigation(); }
    }
    function render() {
        navigation();
        const fragment = document.createDocumentFragment();
        for (const thread of threads) {
            const card = element("details", `review-thread${thread.id === activeId ? " selected" : ""}`);
            card.dataset.thread = thread.id;
            card.open = !thread.resolved || expanded.has(thread.id);
            card.addEventListener("toggle", () => {
                if (thread.resolved) card.open ? expanded.add(thread.id) : expanded.delete(thread.id);
            });
            card.append(element("summary", "", `${thread.resolved ? "✓ " : ""}${thread.anchor.path} · ${location(thread.anchor)} · ${stateLabel(thread)}`));
            const controls = element("div", "review-thread-controls");
            controls.append(action(stale(thread) ? "Original reference (outdated)" : "Go to code", () => locate(thread)));
            controls.append(action(thread.resolved ? "Reopen" : "Resolve", async () => {
                expanded.delete(thread.id);
                await changeThread(thread, "resolve", { resolved: !thread.resolved });
            }));
            card.append(controls);
            if (stale(thread)) card.append(element("p", "review-warning", "The code has changed or the file is no longer in this diff. This is the original reference; old line numbers will not be used to navigate the new code."));
            const quote = element("details", "review-quote");
            quote.append(element("summary", "", `Quoted code · ${thread.anchor.commit.slice(0, 10)} · ${location(thread.anchor)}`), element("pre", "", thread.anchor.quote));
            card.append(quote);
            for (const message of thread.messages) {
                const item = element("div", `review-message ${message.author}`);
                item.append(element("strong", "", message.author === "agent" ? "Agent" : "You"), element("p", "", message.body));
                if (message.delivery?.state === "uncertain") item.append(element("p", "review-warning", `${stateLabel(thread)}. ${message.delivery.error}`));
                card.append(item);
            }
            if (!thread.resolved) {
                const input = element("textarea", "review-reply");
                input.placeholder = "Write a reply to send to the conversation…";
                input.maxLength = 10000;
                input.value = drafts.get(thread.id) ?? "";
                input.setAttribute("aria-label", "Reply to comment");
                input.addEventListener("input", () => { drafts.set(thread.id, input.value); replyIds.delete(thread.id); });
                const send = action("Send reply", async () => {
                    if (posting || !input.value.trim()) return;
                    replyIds.set(thread.id, replyIds.get(thread.id) ?? crypto.randomUUID());
                    await changeThread(thread, "reply", { body: input.value, requestId: replyIds.get(thread.id) });
                    drafts.delete(thread.id);
                    replyIds.delete(thread.id);
                    render();
                }, "review-send");
                send.disabled = posting;
                card.append(input, send);
            }
            fragment.append(card);
        }
        if (!threads.length) fragment.append(element("p", "review-help", "Hover over a line number and click + to comment. Selecting code also shows + beside the last selected line. Shift-click line numbers to select multiple lines. Comments are sent to this canvas's conversation."));
        $("review-list").replaceChildren(fragment);
        annotate();
    }
    async function refresh() {
        const version = ++refreshVersion;
        const id = getState().comparison?.id;
        if (!id) return;
        const response = await request("reviews");
        if (version !== refreshVersion || getState().comparison?.id !== id || response.comparisonId !== id) return;
        enabled = response.enabled;
        threads = response.threads.sort((a, b) => a.anchor.path.localeCompare(b.anchor.path)
            || a.anchor.startLine - b.anchor.startLine || a.anchor.startColumn - b.anchor.startColumn);
        // Preserve textareas and focus when SSE arrives while the user is typing.
        const focused = document.activeElement;
        const threadId = focused?.closest("[data-thread]")?.dataset.thread;
        const caret = focused?.selectionStart;
        render();
        if (threadId && focused.tagName === "TEXTAREA") {
            const input = $("review-list").querySelector(`[data-thread="${threadId}"] textarea`);
            input?.focus({ preventScroll: true });
            input?.setSelectionRange(caret, caret);
        }
    }
    function capture(side, startLine, endLine, startColumn, endColumn) {
        const state = getState();
        if (!state.currentFile?.sources || !state.comparison) return;
        selection = { side, startLine, endLine, startColumn, endColumn, path: state.currentFile.path, comparisonId: state.comparison.id };
        createId = undefined;
        $("review-selection").textContent = `${selection.path} · ${location(selection)}`;
        navigation();
    }
    function clearSelection() {
        if (!$("review-composer").hidden) return;
        selection = undefined;
        updateCommentButtons();
    }
    function captureSelection(event) {
        if (event.target.closest(".number")) return;
        const chosen = window.getSelection();
        if (!chosen?.rangeCount || chosen.isCollapsed) return clearSelection();
        const range = chosen.getRangeAt(0);
        const cellFor = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(".code[data-source-side]");
        const start = cellFor(range.startContainer), end = cellFor(range.endContainer);
        if (!start || !end || start.dataset.sourceSide !== end.dataset.sourceSide
            || typeof getState().currentFile?.sources?.[start.dataset.sourceSide]?.text !== "string") return clearSelection();
        const column = (cell, container, offset) => {
            const prefix = document.createRange();
            prefix.selectNodeContents(cell.querySelector(".code-text"));
            prefix.setEnd(container, offset);
            const state = getState();
            const line = state.currentFile.sources[cell.dataset.sourceSide].text.replace(/\r\n/g, "\n").split("\n")[Number(cell.dataset.line) - 1];
            return Math.min(prefix.toString().length, line.length);
        };
        capture(start.dataset.sourceSide, Number(start.dataset.line), Number(end.dataset.line),
            column(start, range.startContainer, range.startOffset), column(end, range.endContainer, range.endOffset));
    }
    $("diff").addEventListener("pointerup", captureSelection);
    $("diff").addEventListener("keyup", captureSelection);
    function selectLine(cell, extend = false) {
        const side = cell.dataset.sourceSide, line = Number(cell.dataset.line);
        const state = getState();
        const source = state.currentFile?.sources?.[side]?.text;
        if (typeof source !== "string") return;
        const lines = source.replace(/\r\n/g, "\n").split("\n");
        const from = extend && firstLine?.path === state.currentFile.path && firstLine.side === side
            && firstLine.comparisonId === state.comparison.id ? firstLine.line : line;
        firstLine = { path: state.currentFile.path, side, line: from, comparisonId: state.comparison.id };
        capture(side, Math.min(from, line), Math.max(from, line), 0, lines[Math.max(from, line) - 1].length);
    }
    function pickLine(event) {
        if (event.target.closest(".line-comment")) return;
        const cell = event.target.closest(".number[data-source-side]");
        if (!cell) return;
        if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        selectLine(cell, event.shiftKey);
    }
    $("diff").addEventListener("click", pickLine);
    $("diff").addEventListener("keydown", pickLine);
    $("diff").addEventListener("pointerdown", (event) => {
        if (event.target.closest(".line-comment")) event.preventDefault();
    });
    $("diff").addEventListener("click", (event) => {
        const button = event.target.closest(".line-comment");
        if (!button || button.disabled) return;
        const number = button.parentElement;
        const line = Number(number.dataset.line);
        if (!selection || !currentSelection() || selection.side !== number.dataset.sourceSide
            || line < selection.startLine || line > selection.endLine) selectLine(number, event.shiftKey);
        if (!selection || !currentSelection()) return;
        dock();
        $("review-composer").hidden = false;
        $("review-body").focus();
    });
    $("review-body").addEventListener("input", () => { createId = undefined; });
    $("review-cancel").addEventListener("click", () => { $("review-composer").hidden = true; });
    $("review-submit").addEventListener("click", async () => {
        if (posting || !selection) return;
        if (selection.comparisonId !== getState().comparison?.id) return showError(new Error("The comparison has changed. Select the code again."));
        posting = true;
        $("review-submit").disabled = true;
        navigation();
        try {
            createId ??= crypto.randomUUID();
            const thread = await request("reviews/create", { ...selection, body: $("review-body").value, requestId: createId });
            activeId = thread.id;
            $("review-body").value = "";
            $("review-composer").hidden = true;
            selection = undefined;
            createId = undefined;
            await refresh();
        } catch (error) { showError(error); }
        finally { posting = false; $("review-submit").disabled = false; navigation(); }
    });
    $("review-toggle").addEventListener("click", () => {
        $("review-panel").hidden = !$("review-panel").hidden;
        $("review-toggle").setAttribute("aria-expanded", String(!$("review-panel").hidden));
    });
    for (const [id, delta] of [["comment-prev", -1], ["comment-next", 1]]) {
        $(id).addEventListener("click", () => {
            const visible = threads.filter((thread) => !thread.resolved);
            const index = visible.findIndex((thread) => thread.id === activeId) + delta;
            if (visible[index]) locate(visible[index]).catch(showError);
        });
    }
    return { refresh, annotate };
}
