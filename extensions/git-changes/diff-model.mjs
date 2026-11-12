export function groups(lines) {
    const result = [];
    for (const line of lines) {
        const changed = line.type === "add" || line.type === "delete";
        const last = result.at(-1);
        if (last && (line.type === "note" || last.changed === changed)) last.lines.push(line);
        else result.push({ changed, lines: [line] });
    }
    return result;
}

export function fullFileChanges(hunks, side) {
    const field = side === "left" ? "oldLine" : "newLine";
    const type = side === "left" ? "delete" : "add";
    const result = [];
    for (const hunk of hunks) {
        let nextLine = side === "left"
            ? hunk.oldStart + (hunk.oldCount === 0 ? 1 : 0)
            : hunk.newStart + (hunk.newCount === 0 ? 1 : 0);
        for (const group of groups(hunk.lines)) {
            const shown = group.lines.filter((line) => line[field] != null);
            if (group.changed) {
                result.push({
                    start: shown[0]?.[field] ?? nextLine,
                    end: shown.at(-1)?.[field] ?? nextLine,
                    type: shown.length ? type : type === "add" ? "delete" : "add",
                    marker: !shown.length,
                    hiddenLines: group.lines.filter((line) => line.type !== "note" && line[field] == null).length,
                });
            }
            if (shown.length) nextLine = shown.at(-1)[field] + 1;
        }
    }
    return result;
}

export function* fullFileSections(leftLines, rightLines, hunks) {
    const leftChanges = fullFileChanges(hunks, "left");
    const rightChanges = fullFileChanges(hunks, "right");
    let oldLine = 1;
    let newLine = 1;
    function section(oldEnd, newEnd, changed) {
        const rows = [];
        const start = newLine;
        const oldStart = oldLine;
        while (oldLine <= oldEnd || newLine <= newEnd) {
            const left = oldLine <= oldEnd
                ? { text: leftLines[oldLine - 1], oldLine: oldLine++, type: changed ? "delete" : "context" }
                : null;
            const right = newLine <= newEnd
                ? { text: rightLines[newLine - 1], newLine: newLine++, type: changed ? "add" : "context" }
                : null;
            rows.push({ left, right });
        }
        return { changed, start, oldStart, rows };
    }
    for (let i = 0; i < leftChanges.length; i++) {
        const left = leftChanges[i];
        const right = rightChanges[i];
        const context = section(left.start - 1, right.start - 1, false);
        if (context.rows.length) yield context;
        yield section(left.marker ? left.start - 1 : left.end, right.marker ? right.start - 1 : right.end, true);
    }
    const tail = section(leftLines.length, rightLines.length, false);
    if (tail.rows.length) yield tail;
}

export function splitRows(lines) {
    const removed = lines.filter((line) => line.type === "delete");
    const added = lines.filter((line) => line.type === "add");
    if (!removed.length && !added.length) {
        return lines.map((line) => ({ left: line, right: line }));
    }
    const result = Array.from({ length: Math.max(removed.length, added.length) }, (_, index) => ({
        left: removed[index] ?? null, right: added[index] ?? null,
    }));
    for (const note of lines.filter((line) => line.type === "note")) result.push({ left: note, right: note });
    return result;
}

export function wordRange(left, right) {
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    let endLeft = left.length;
    let endRight = right.length;
    while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
        endLeft--;
        endRight--;
    }
    return { start, endLeft, endRight };
}
