import hljs from "./vendor/highlight.mjs";

const languages = {
    cs: "csharp", csx: "csharp", java: "java", kt: "kotlin", kts: "kotlin",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", jsonc: "json",
    py: "python", rb: "ruby", go: "go", rs: "rust", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
    html: "xml", htm: "xml", xml: "xml", csproj: "xml", props: "xml", targets: "xml", xaml: "xml",
    css: "css", scss: "scss", less: "less", md: "markdown", mdx: "markdown",
    yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", sql: "sql", ini: "ini", toml: "ini",
};

export function sourceLines(text) {
    if (!text) return [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

export function highlightLines(text, path) {
    const raw = sourceLines(text);
    const language = languages[path.split(".").at(-1).toLowerCase()];
    const plain = () => raw.map((line) => [{ text: line, classes: "" }]);
    if (!language || !hljs.getLanguage(language)) return { lines: plain(), language: "Plain text", notice: "" };
    if (text.length > 1024 * 1024) return { lines: plain(), language, notice: "Syntax highlighting is paused for this large file; the full text is still displayed" };
    const normalized = text.replace(/\r\n/g, "\n");
    const template = document.createElement("template");
    template.innerHTML = hljs.highlight(normalized, { language, ignoreIllegals: true }).value;
    const lines = [[]];
    function walk(node, classes = "") {
        if (node.nodeType === Node.TEXT_NODE) {
            const pieces = node.textContent.split("\n");
            pieces.forEach((piece, index) => {
                if (index) lines.push([]);
                if (piece) lines.at(-1).push({ text: piece, classes });
            });
        } else {
            const next = node.nodeType === Node.ELEMENT_NODE ? `${classes} ${node.className}`.trim() : classes;
            for (const child of node.childNodes) walk(child, next);
        }
    }
    walk(template.content);
    return { lines: lines.slice(0, raw.length), language, notice: "" };
}

export function appendCode(element, text, tokens, range) {
    const parts = tokens ?? [{ text, classes: "" }];
    let offset = 0;
    for (const token of parts) {
        const end = offset + token.text.length;
        const boundaries = [offset, end];
        if (range) boundaries.push(...range.filter((value) => value > offset && value < end));
        boundaries.sort((a, b) => a - b);
        for (let i = 0; i < boundaries.length - 1; i++) {
            const start = boundaries[i];
            const value = token.text.slice(start - offset, boundaries[i + 1] - offset);
            const marked = range && start >= range[0] && start < range[1];
            const classes = `${token.classes}${marked ? " word" : ""}`.trim();
            if (classes) {
                const span = document.createElement("span");
                span.className = classes;
                span.textContent = value;
                element.append(span);
            } else element.append(document.createTextNode(value));
        }
        offset = end;
    }
    if (!text) element.append(document.createTextNode("\u200b"));
}
