import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.mjs";
import { createPanel } from "./server.mjs";

// Keep the extension dependency-free; browser test tooling lives in the test cwd.
const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");
const root = await mkdtemp(join(process.cwd(), "sandbox-test-"));
let browser;
let panel;
let host;
try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Canvas test"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await git(root, ["config", "core.autocrlf", "false"]);
    const lines = Array.from({ length: 60 }, (_, i) => `// unchanged line ${i + 1}`);
    lines[0] = "public class Example {";
    lines[1] = '    public string Value = "before";';
    lines[2] = `// ${"long unchanged content ".repeat(30)}`;
    lines[10] = "/* multi-line comment";
    lines[11] = "comment content";
    lines[12] = "*/";
    lines[59] = "}";
    const baseLines = [...lines];
    await writeFile(join(root, "first.cs"), lines.join("\n") + "\n");
    await writeFile(join(root, "y-align.cs"), "// before\n// old1\n// old2\n// middle\n// tail\n");
    const retained = Array.from({ length: 60 }, (_, i) => `// retained line ${i + 1}`);
    await writeFile(join(root, "y-deletions.cs"), ["// removed at start", ...retained, "// removed at end"].join("\n") + "\n");
    await writeFile(join(root, "y-empty.cs"), "// remove one\n// remove two\n");
    await writeFile(join(root, "z-deleted.cs"), "public class Deleted {}\n");
    await writeFile(join(root, "z-deleted-empty.cs"), "");
    await writeFile(join(root, "z-binary.bin"), Buffer.from([0, 1, 2]));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(root, ["switch", "-c", "feature"]);
    lines[1] = '    public string Value = "<script>alert(1)</script>";';
    lines[49] = "    public const int Limit = 42;";
    await writeFile(join(root, "first.cs"), lines.join("\n") + "\n");
    await writeFile(join(root, "second.txt"), "new file");
    await writeFile(join(root, "y-align.cs"), "// before\n// new\n// middle\n// added1\n// added2\n// tail\n");
    await writeFile(join(root, "zz-empty.cs"), "");
    await writeFile(join(root, "y-deletions.cs"), retained.join("\n") + "\n");
    await writeFile(join(root, "y-empty.cs"), "");
    await writeFile(join(root, "z-binary.bin"), Buffer.from([0, 1, 3]));
    await rm(join(root, "z-deleted.cs"));
    await rm(join(root, "z-deleted-empty.cs"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "changes"]);
    const storage = join(root, ".git", "settings.json");
    await writeFile(storage, JSON.stringify({
        lastRepo: "C:\\not-the-active-workspace",
        repositories: [{ repo: root, base: "feature", target: "main" }],
    }));
    panel = await createPanel({}, storage, { workingDirectory: root });
    host = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><title>Sandbox regression</title><iframe id="canvas" sandbox="allow-scripts" src="${panel.url}" style="width:100%;height:900px"></iframe>`);
    });
    await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
    await page.goto(`http://127.0.0.1:${host.address().port}/`);
    const frame = page.frameLocator("#canvas");
    const settleLayout = () => frame.locator("#diff").evaluate(() =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function splitGeometry() {
        await settleLayout();
        return frame.locator("#code-view").evaluate((container) => {
            const diff = document.getElementById("diff");
            const origin = diff.getBoundingClientRect().left;
            const boundaries = [...diff.querySelectorAll(".split-table tr")].map((row) =>
                row.children[2].getBoundingClientRect().left - origin);
            boundaries.push(document.getElementById("right-label").getBoundingClientRect().left - origin);
            if (!document.getElementById("horizontal").hidden) boundaries.push(document.getElementById("right-scroll").getBoundingClientRect().left - origin);
            const handle = document.getElementById("pane-resize").getBoundingClientRect();
            boundaries.push(handle.left + handle.width / 2 - origin);
            return { width: diff.clientWidth, left: parseFloat(container.style.getPropertyValue("--split-position")), boundaries };
        });
    }
    async function assertSplit(ratio) {
        const geometry = await splitGeometry();
        assert(Math.abs(geometry.left / geometry.width - ratio) < .005, JSON.stringify(geometry));
        assert(geometry.boundaries.every((left) => Math.abs(left - geometry.left) < 2), JSON.stringify(geometry));
        assert(geometry.left >= Math.min(160, geometry.width / 2) - 1);
        assert(geometry.width - geometry.left >= Math.min(160, geometry.width / 2) - 1);
        assert.equal(await frame.locator("#pane-resize").isVisible(), true);
        return geometry;
    }
    async function dragSplit(ratio) {
        const handle = await frame.locator("#pane-resize").boundingBox();
        const diff = await frame.locator("#diff").boundingBox();
        const width = await frame.locator("#diff").evaluate((element) => element.clientWidth);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 12);
        await page.mouse.down();
        await page.mouse.move(diff.x + width * ratio, handle.y + 12, { steps: 8 });
        await page.mouse.up();
        await settleLayout();
        assert.equal(await frame.locator("body").evaluate((body) => body.classList.contains("resizing-panes")), false);
    }
    async function assertSingle(side) {
        await settleLayout();
        assert.equal(await frame.locator("#view").isDisabled(), true);
        assert.equal(await frame.locator("#view").inputValue(), "single");
        assert.equal(await frame.locator("#right-label").isVisible(), false);
        assert.equal(await frame.locator("#right-scroll").isVisible(), false);
        assert.equal(await frame.locator("#pane-resize").isVisible(), false);
        assert.equal(await frame.locator(".split-table, .code.blank").count(), 0);
        assert.equal(await frame.locator(`.code[data-source-side="${side === "base" ? "target" : "base"}"]`).count(), 0);
        const fullWidth = await frame.locator("#diff").evaluate((diff) => {
            const table = diff.querySelector(".diff-table");
            return !table || Math.abs(table.getBoundingClientRect().width - diff.clientWidth) < 2;
        });
        assert(fullWidth, "A single panel should use the entire content width");
    }
    await frame.locator(".change-anchor").first().waitFor();
    assert.equal(panel.summary().settings.repo, root);
    assert.equal(await frame.locator(".brand, .logo, .readonly, .repo-row, #repo, #load-repo, #repositories").count(), 0);
    assert((await frame.locator("header").boundingBox()).height <= 115, "The header should contain only the comparison controls");
    assert.equal(await frame.locator("#target").inputValue(), "feature");
    assert.equal(await frame.locator("#base").inputValue(), "origin/main");
    assert.equal(await frame.locator("html").getAttribute("lang"), "en");
    assert.equal(await frame.locator(".command-row, #command, #context, #resolved").count(), 0);
    const interfaceText = await frame.locator("body").evaluate((body) => [
        body.innerText,
        ...[...body.querySelectorAll("[title], [placeholder], [aria-label]")].flatMap((element) =>
            ["title", "placeholder", "aria-label"].map((attribute) => element.getAttribute(attribute) ?? "")),
    ].join("\n"));
    assert.doesNotMatch(interfaceText, /\p{Script=Han}/u);
    assert.equal(await frame.locator(".file").count(), 9);
    assert.equal(await frame.locator("[data-path='second.txt'] .file-stat").textContent(), "+1");
    assert.equal(await frame.locator("[data-path='z-deleted.cs'] .file-stat").textContent(), "−1");
    assert.equal(await frame.locator("[data-path='y-empty.cs'] .file-stat").textContent(), "−2");
    assert.equal(await frame.locator("[data-path='zz-empty.cs'] .file-stat").count(), 0);
    assert.equal(await frame.locator("[data-path='z-binary.bin'] .file-stat").textContent(), "binary");
    assert.equal(await frame.locator("[data-path='first.cs'] .file-stat").textContent(), "+2 −2");
    assert.deepEqual(await frame.locator(".file-stat .plus, .file-stat .minus").evaluateAll((elements) =>
        elements.filter((element) => /[+−]0$/.test(element.textContent)).map((element) => element.textContent)), []);
    assert(await frame.locator(".hljs-keyword").count() > 0);
    assert(await frame.locator(".hljs-string.word").count() > 0);
    assert.equal(await frame.locator("#diff script").count(), 0);
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    await assertSplit(.5);
    await dragSplit(.65);
    await assertSplit(.65);
    const beforeKey = await splitGeometry();
    await frame.locator("#pane-resize").press("ArrowLeft");
    await assertSplit((beforeKey.left - 20) / beforeKey.width);
    await frame.locator("#pane-resize").press("ArrowRight");
    await assertSplit(.65);
    await dragSplit(-.1);
    assert(Math.abs((await splitGeometry()).left - 160) < 1);
    await dragSplit(.99);
    const maximum = await splitGeometry();
    assert(Math.abs(maximum.width - maximum.left - 160) < 1);
    await dragSplit(.65);
    // Cancelled drags and capture loss must not leave the page in resize mode.
    for (const event of ["pointercancel", "lostpointercapture"]) {
        const handle = await frame.locator("#pane-resize").boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 12);
        await page.mouse.down();
        await frame.locator("#pane-resize").dispatchEvent(event);
        assert.equal(await frame.locator("body").evaluate((body) => body.classList.contains("resizing-panes")), false);
        await page.mouse.up();
    }
    await page.setViewportSize({ width: 520, height: 1100 });
    await assertSplit(.5);
    await page.setViewportSize({ width: 1400, height: 1100 });
    await assertSplit(.65);
    await frame.locator("#next").click();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#next").click();
    await frame.locator(".file[aria-selected=true][data-path='second.txt']").waitFor();
    await frame.locator("#prev:not(:disabled)").waitFor();
    await assertSingle("target");
    assert.match(await frame.locator("#diff").textContent(), /No newline at end of file/);
    await frame.locator("#prev").click();
    await frame.locator(".file[aria-selected=true][data-path='first.cs']").waitFor();
    await frame.locator("#next:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await assertSplit(.65);
    await frame.locator("#full-file").click();
    await frame.locator(".full-split").waitFor();
    assert.equal(await frame.locator("#view").isEnabled(), true);
    assert.equal(await frame.locator(".full-table tbody tr").count(), 60);
    assert.deepEqual(await frame.locator(".full-table .code.left .code-text").allTextContents(), baseLines);
    assert.deepEqual(await frame.locator(".full-table .code.right .code-text").allTextContents(), lines);
    assert.equal(await frame.locator("#right-label").isVisible(), true);
    assert.equal(await frame.locator("#right-scroll").isVisible(), true);
    await assertSplit(.65);
    const scrollBefore = await frame.locator("#diff").evaluate((diff) => diff.scrollTop);
    await dragSplit(.6);
    await assertSplit(.6);
    assert.equal(await frame.locator("#diff").evaluate((diff) => diff.scrollTop), scrollBefore);
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#left-scroll").evaluate((rail) => { rail.scrollLeft = rail.scrollWidth; });
    await settleLayout();
    const scrolling = await frame.locator("#diff").evaluate((diff) => ({
        left: parseFloat(diff.style.getPropertyValue("--scroll-left")),
        right: parseFloat(diff.style.getPropertyValue("--scroll-right")),
    }));
    assert(scrolling.left > 0 && scrolling.right === 0, "Each panel should scroll horizontally independently after resizing");
    await frame.locator("#wrap").click();
    await dragSplit(.65);
    await assertSplit(.65);
    assert.equal(await frame.locator("#horizontal").isVisible(), false);
    const wrapped = await frame.locator(".full-split tr").nth(2).evaluate((row) => {
        const a = row.querySelector(".code.left").getBoundingClientRect();
        const b = row.querySelector(".code.right").getBoundingClientRect();
        return a.top === b.top && a.height === b.height && a.height > 21;
    });
    assert(wrapped, "Wrapped rows should remain aligned at unequal panel widths");
    await frame.locator("#wrap").click();
    // Measure contrast in both app themes, not just distinct CSS variable names.
    for (const mode of ["light", "dark"]) {
        const colors = await frame.locator("body").evaluate((body, mode) => {
            const root = document.documentElement;
            root.dataset.colorMode = mode;
            root.style.setProperty("--background-color-default", mode === "dark" ? "#0d1117" : "#ffffff");
            root.style.setProperty("--text-color-default", mode === "dark" ? "#e6edf3" : "#1f2328");
            const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = (color) => rgb(color).map((value) => {
                const c = value / 255;
                return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
            }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
            const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
            const add = getComputedStyle(document.querySelector(".code.add"));
            const remove = getComputedStyle(document.querySelector(".code.delete"));
            const comment = getComputedStyle(document.querySelector(".code.delete .hljs-comment"));
            const background = getComputedStyle(body).backgroundColor;
            return {
                addContrast: contrast(add.backgroundColor, background),
                deleteContrast: contrast(remove.backgroundColor, background),
                addTextContrast: contrast(add.color, add.backgroundColor),
                deleteTextContrast: contrast(remove.color, remove.backgroundColor),
                commentContrast: contrast(comment.color, remove.backgroundColor),
                colorDistance: Math.hypot(...rgb(add.backgroundColor).map((value, index) => value - rgb(remove.backgroundColor)[index])),
            };
        }, mode);
        assert(colors.addContrast >= 1.25, JSON.stringify({ mode, colors }));
        assert(colors.deleteContrast >= 1.25, JSON.stringify({ mode, colors }));
        assert(colors.colorDistance >= 50, JSON.stringify({ mode, colors }));
        assert(colors.addTextContrast >= 4.5 && colors.deleteTextContrast >= 4.5 && colors.commentContrast >= 4.5, JSON.stringify({ mode, colors }));
    }
    await frame.locator("#view").selectOption("unified");
    await settleLayout();
    assert.equal(await frame.locator("#pane-resize").isVisible(), false);
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "true");
    assert.deepEqual(await frame.locator(".full-table .code-text").allTextContents(), lines);
    assert.equal(await frame.locator(".full-table .code-text").nth(11).locator(".hljs-comment").count(), 1);
    assert.equal(await frame.locator("#diff script").count(), 0);
    assert.equal(await frame.locator("#next").isDisabled(), false);
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#prev").click();
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    assert.equal(await frame.locator(".change-anchor.active").getAttribute("data-line"), "2");
    await frame.locator("#next").click();
    assert.equal(await frame.locator(".change-anchor.active").getAttribute("data-line"), "50");
    assert(await frame.locator("#diff").evaluate((element) => element.scrollTop) > 0);
    await frame.locator("#next").click();
    await frame.locator(".file[aria-selected=true][data-path='second.txt']").waitFor();
    await frame.locator("#prev:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "true");
    await frame.locator("#prev").click();
    await frame.locator(".file[aria-selected=true][data-path='first.cs']").waitFor();
    await frame.locator("#next:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#diff").press("Shift+F7");
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    await frame.locator("#diff").press("F7");
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#view").selectOption("split");
    await assertSplit(.65);
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#prev").click();
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    await frame.locator("#next").click();
    await frame.locator("#next").click();
    await frame.locator(".file[aria-selected=true][data-path='second.txt']").waitFor();
    await frame.locator("#prev:not(:disabled)").waitFor();
    await assertSingle("target");
    assert.equal(await frame.locator(".full-table .code.add").textContent(), "new file");
    await frame.locator("#prev").click();
    await frame.locator(".file[aria-selected=true][data-path='first.cs']").waitFor();
    await frame.locator("#next:not(:disabled)").waitFor();
    await assertSplit(.65);
    await frame.locator("#full-file").click();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    assert.equal(await frame.locator(".full-table").count(), 0);
    await frame.locator("#view").selectOption("unified");
    await frame.locator("#wrap").click();
    assert.equal(await frame.locator("#wrap").getAttribute("aria-pressed"), "true");
    await frame.locator("#mode").selectOption("endpoints");
    await frame.locator("#compare").click();
    for (let i = 0; i < 50 && panel.summary().comparison?.mode !== "endpoints"; i++) await page.waitForTimeout(100);
    assert.equal(panel.summary().comparison?.mode, "endpoints", "Compare button must work in an allow-scripts-only iframe");
    await frame.locator("#compare:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#error").isVisible(), false);
    await frame.locator("#mode").selectOption("merge-base");
    await frame.locator("#target").press("Enter");
    for (let i = 0; i < 50 && panel.summary().comparison?.mode !== "merge-base"; i++) await page.waitForTimeout(100);
    assert.equal(panel.summary().comparison?.mode, "merge-base", "Enter should compare without submitting a form");
    // Reload must bootstrap automatically, without browser/agent setup calls.
    await page.reload();
    await frame.locator(".change-anchor").first().waitFor();
    assert.equal(await frame.locator("#error").isVisible(), false);
    assert.equal(await frame.locator("#view").inputValue(), "unified");
    await frame.locator("#view").selectOption("split");
    await assertSplit(.5);
    await frame.locator("#view").selectOption("unified");
    assert(await frame.locator(".hljs-keyword").count() > 0);
    await frame.locator("[data-path='y-deletions.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    await frame.locator("#full-file").click();
    await frame.locator(".full-table").waitFor();
    assert.equal(await frame.locator(".full-change-marker").count(), 2);
    assert.deepEqual(await frame.locator(".full-table .code-text").allTextContents(), retained);
    assert.equal(await frame.locator(".change-anchor.active").getAttribute("data-line"), "1");
    await frame.locator("#next").click();
    assert.equal(await frame.locator(".change-anchor.active").getAttribute("data-line"), "61");
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    const markerVisible = await frame.locator(".change-anchor.active").evaluate((element) => {
        const viewport = document.getElementById("diff").getBoundingClientRect();
        const marker = element.getBoundingClientRect();
        return marker.top >= viewport.top && marker.bottom <= viewport.bottom;
    });
    assert.equal(markerVisible, true);
    await frame.locator("[data-path='y-empty.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.equal(await frame.locator(".full-change-marker").count(), 1);
    assert.equal(await frame.locator(".source-line").count(), 0);
    assert.equal(await frame.locator("#position").textContent(), "1 / 1");
    await frame.locator("#full-file").click();
    await frame.locator("[data-path='z-deleted.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    await assertSingle("base");
    await frame.locator("#full-file").click();
    await frame.locator(".full-table").waitFor();
    assert.equal(await frame.locator(".full-table .code-text").textContent(), "public class Deleted {}");
    assert.match(await frame.locator("#left-label").textContent(), /Deleted file/);
    for (let i = 0; i < 50 && (!panel.summary().settings.fullFile || panel.summary().settings.selectedPath !== "z-deleted.cs"); i++) await page.waitForTimeout(20);
    assert.equal(panel.summary().settings.fullFile, true);
    await page.reload();
    await frame.locator(".full-table").waitFor();
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "true");
    await assertSingle("base");
    assert.equal(await frame.locator(".full-table .code.left.delete").textContent(), "public class Deleted {}");
    assert.equal(await frame.locator(".full-table .code.right:not(.blank)").count(), 0);
    assert.match(await frame.locator("#left-label").textContent(), /Deleted file/);
    await frame.locator("[data-path='y-align.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#view").inputValue(), "unified");
    await frame.locator("#view").selectOption("split");
    await assertSplit(.5);
    const aligned = await frame.locator(".full-split tr").evaluateAll((rows) => rows.map((row) => ({
        left: row.querySelector(".code.left:not(.blank)")?.textContent ?? null,
        right: row.querySelector(".code.right:not(.blank)")?.textContent ?? null,
    })));
    assert.deepEqual(aligned, [
        { left: "// before", right: "// before" },
        { left: "// old1", right: "// new" },
        { left: "// old2", right: null },
        { left: "// middle", right: "// middle" },
        { left: null, right: "// added1" },
        { left: null, right: "// added2" },
        { left: "// tail", right: "// tail" },
    ]);
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    await frame.locator("#next").click();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    // Layout and source text remain aligned with wrapping enabled.
    const geometry = await frame.locator(".full-split tr").first().evaluate((row) => {
        const a = row.querySelector(".code.left").getBoundingClientRect();
        const b = row.querySelector(".code.right").getBoundingClientRect();
        return { aligned: a.top === b.top && a.height === b.height, sideBySide: a.right <= b.left };
    });
    assert.deepEqual(geometry, { aligned: true, sideBySide: true });
    for (let i = 0; i < 50 && (panel.summary().settings.view !== "split" || panel.summary().settings.selectedPath !== "y-align.cs"); i++) await page.waitForTimeout(20);
    await page.reload();
    await frame.locator(".full-split").waitFor();
    assert.equal(await frame.locator("#view").inputValue(), "split");
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "true");
    await frame.locator("[data-path='y-empty.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    await assertSplit(.5);
    assert.equal(await frame.locator("#view").isEnabled(), true, "Emptying an existing file is not a deletion");
    await frame.locator("[data-path='zz-empty.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    await assertSingle("target");
    assert.match(await frame.locator("#diff").textContent(), /Empty file/);
    assert.equal(await frame.locator(".full-split tr").count(), 0);
    assert.equal(await frame.locator("#position").textContent(), "0 / 0");
    await frame.locator("[data-path='z-deleted-empty.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    await assertSingle("base");
    assert.match(await frame.locator("#diff").textContent(), /Empty file/);
    await frame.locator("[data-path='z-binary.bin']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.match(await frame.locator("#diff").textContent(), /Binary/);
    assert.doesNotMatch(await frame.locator("body").innerText(), /\p{Script=Han}/u);
    await frame.locator("#full-file").click();
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "false");

    await writeFile(join(root, "uncommitted.txt"), "staged text\n");
    await git(root, ["add", "uncommitted.txt"]);
    await writeFile(join(root, "uncommitted.txt"), "working text\n");
    await writeFile(join(root, "untracked.txt"), "new untracked text\n");
    await frame.locator("#compare").click();
    await frame.locator('.file[data-path="untracked.txt"]').waitFor();
    await frame.locator('.file[data-path="uncommitted.txt"]').click();
    await frame.getByText("working text", { exact: true }).waitFor();
    await assertSingle("target");
    await frame.locator('.file[data-path="untracked.txt"]').click();
    await frame.getByText("new untracked text", { exact: true }).waitFor();
    await assertSingle("target");
    assert.match(await frame.locator("#scope-note").textContent(), /staged, unstaged and untracked/);
    await frame.locator("#include-uncommitted").uncheck();
    await frame.locator("#compare").click();
    await frame.locator('.file[data-path="untracked.txt"]').waitFor({ state: "detached" });
    assert.equal(await frame.locator('.file[data-path="uncommitted.txt"]').count(), 0);
    await frame.locator("#compare:not(:disabled)").waitFor();
    await page.reload();
    await frame.locator(".change-anchor").first().waitFor();
    assert.equal(await frame.locator("#include-uncommitted").isChecked(), false);

    for (const directory of ["src\\ui", "src\\lib", "src2"]) await mkdir(join(root, directory), { recursive: true });
    for (const path of ["src\\ui\\a.txt", "src\\ui\\b.txt", "src\\lib\\c.txt", "src2\\other.txt", "review-root.txt"]) {
        await writeFile(join(root, path), "review this file\nsecond line\n");
    }
    await frame.locator("#include-uncommitted").check();
    await frame.locator("#compare").click();
    const directory = (path) => frame.locator(`.directory[data-directory="${path}"]`);
    const file = (path) => frame.locator(`.file[data-path="${path}"]`);
    const checkbox = (path) => file(path).locator(".file-reviewed");
    const directoryCheckbox = (path) => directory(path).locator(":scope > .directory-row > .directory-reviewed");
    async function markReviewed(path, checked, keyboard = false) {
        const response = page.waitForResponse((response) => response.url().endsWith("/file-reviews") && response.request().method() === "POST");
        if (keyboard) await file(path).press(" ");
        else await checkbox(path).setChecked(checked);
        assert.equal((await response).status(), 200);
        await file(path).locator(".file-reviewed:enabled").waitFor({ state: "attached" });
        assert.equal(await checkbox(path).isChecked(), checked);
    }
    await directory("src/ui").waitFor();
    assert.equal(await frame.locator("#files").getAttribute("role"), "tree");
    assert.equal(await directory("src").locator(':scope > .file-group > .directory[data-directory="src/ui"]').count(), 1);
    const filenameBeforeReview = await frame.locator("#filename").textContent();
    await directory("src").locator(":scope > .directory-row").click();
    assert.equal(await file("src/ui/a.txt").isVisible(), false);
    await frame.locator("#filter").fill("a.txt");
    assert.equal(await file("src/ui/a.txt").isVisible(), true);
    await markReviewed("src/ui/a.txt", true);
    assert.equal(await directory("src").getAttribute("aria-checked"), "mixed");
    assert.equal(await directoryCheckbox("src/ui").evaluate((input) => input.indeterminate), true);
    assert.equal(await directory("src/ui").getAttribute("aria-expanded"), "true", "Hidden unreviewed siblings must prevent automatic collapse");
    assert.equal(await frame.locator("#filename").textContent(), filenameBeforeReview, "A checkbox must not open another file");
    await frame.locator("#filter").fill("b.txt");
    await markReviewed("src/ui/b.txt", true);
    assert.equal(await directory("src/ui").getAttribute("aria-expanded"), "false");
    await frame.locator("#filter").fill("");
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false", "Clearing a filter restores manual collapse state");
    await directory("src").locator(":scope > .directory-row").click();
    await directory("src/ui").locator(":scope > .directory-row").click();
    await markReviewed("src/ui/a.txt", false);
    assert.equal(await directory("src/ui").getAttribute("aria-expanded"), "true");
    await markReviewed("src/ui/a.txt", true, true);
    assert.equal(await directory("src/ui").getAttribute("aria-expanded"), "false");
    assert.equal(await file("src/ui/a.txt").evaluate((item) => item.parentElement.parentElement === document.activeElement), true, "Focus should move to the collapsed directory");
    await markReviewed("src/lib/c.txt", true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false", "All reviewed descendants collapse the parent too");
    assert.equal(await directory("src2").getAttribute("aria-expanded"), "true");
    await markReviewed("review-root.txt", true);
    assert.equal(await file("review-root.txt").isVisible(), true);
    await page.reload();
    await directory("src").waitFor();
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false");
    assert.equal(await checkbox("src/ui/a.txt").isChecked(), true);
    assert.equal(await checkbox("review-root.txt").isChecked(), true);
    await page.goto("about:blank");
    await panel.close();
    panel = await createPanel({}, storage, { workingDirectory: root });
    await page.goto(`http://127.0.0.1:${host.address().port}/`);
    await directory("src").waitFor();
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false");
    assert.equal(await checkbox("src/ui/b.txt").isChecked(), true);
    await directory("src").press("ArrowRight");
    assert.equal(await directory("src").getAttribute("aria-expanded"), "true");
    await directory("src/ui").press("ArrowRight");
    await file("src/ui/a.txt").press("ArrowDown");
    assert.equal(await file("src/ui/b.txt").evaluate((item) => item === document.activeElement), true);
    await file("src/ui/b.txt").press("Enter");
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#filename").textContent(), "src/ui/b.txt");
    await directory("src").locator(":scope > .directory-row").click();
    await frame.locator("#diff").press("Shift+F7");
    await frame.locator(".file[aria-selected=true][data-path='src/ui/a.txt']").waitFor();
    assert.equal(await directory("src").getAttribute("aria-expanded"), "true");
    assert.equal(await file("src/ui/a.txt").isVisible(), true);
    await writeFile(join(root, "src", "ui", "a.txt"), "changed after review\n");
    await frame.locator("#compare").click();
    await frame.getByText("changed after review", { exact: true }).waitFor();
    assert.equal(await checkbox("src/ui/a.txt").isChecked(), false);
    assert.equal(await checkbox("src/ui/b.txt").isChecked(), true);
    assert.equal(await directory("src/ui").getAttribute("aria-expanded"), "true");
    assert.equal(await frame.locator("#error").isVisible(), false);

    async function markDirectory(path, checked, keyboard = false) {
        const response = page.waitForResponse((response) => response.url().endsWith("/file-reviews")
            && response.request().method() === "POST" && response.request().postDataJSON().directory === path);
        if (keyboard) await directory(path).press(" ");
        else await directoryCheckbox(path).setChecked(checked);
        assert.equal((await response).status(), 200);
        await directory(path).locator(":scope > .directory-row > .directory-reviewed:enabled").waitFor({ state: "attached" });
        assert.equal(await directoryCheckbox(path).isChecked(), checked);
        assert.equal(await directoryCheckbox(path).evaluate((input) => input.indeterminate), false);
    }
    assert.equal(await directoryCheckbox("src").evaluate((input) => input.indeterminate), true);
    await markDirectory("src", true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false");
    await markDirectory("src", false, true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "true");
    for (const path of ["src/ui/a.txt", "src/ui/b.txt", "src/lib/c.txt"]) assert.equal(await checkbox(path).isChecked(), false);
    assert.equal(await checkbox("review-root.txt").isChecked(), true, "Directory changes must not affect files outside it");
    await frame.locator("#filter").fill("a.txt");
    const selectedBeforeBatch = await frame.locator("#filename").textContent();
    await markDirectory("src", true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false");
    assert.equal(await frame.locator("#filename").textContent(), selectedBeforeBatch);
    await frame.locator("#filter").fill("");
    for (const path of ["src/ui/a.txt", "src/ui/b.txt", "src/lib/c.txt"]) assert.equal(await checkbox(path).isChecked(), true, "A directory checkbox must include filtered-out descendants");
    assert.equal(await checkbox("src2/other.txt").isChecked(), false);
    await page.reload();
    await directory("src").waitFor();
    assert.equal(await directoryCheckbox("src").isChecked(), true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false");
    await directory("src").press("ArrowRight");
    await markDirectory("src/ui", false);
    assert.equal(await directoryCheckbox("src").evaluate((input) => input.indeterminate), true);
    assert.equal(await checkbox("src/lib/c.txt").isChecked(), true);
    await markDirectory("src", true, true);
    assert.equal(await directory("src").getAttribute("aria-expanded"), "false", "Space on a partially reviewed directory marks all descendants reviewed");
    assert.equal(await frame.locator("#error").isVisible(), false);

    for (const path of ["compact\\chain\\leaf", "mixed\\inner\\leaf"]) await mkdir(join(root, path), { recursive: true });
    for (const path of ["compact\\chain\\leaf\\a.txt", "compact\\chain\\leaf\\b.txt", "mixed\\direct.txt", "mixed\\inner\\leaf\\nested.txt"]) {
        await writeFile(join(root, path), "compact directory review\n");
    }
    await frame.locator("#compare").click();
    await directory("compact/chain/leaf").waitFor();
    const compactRow = directory("compact/chain/leaf").locator(":scope > .directory-row");
    assert.equal(await compactRow.locator(".file-names").textContent(), "compact/chain/leaf");
    assert.equal(await compactRow.getAttribute("title"), "compact/chain/leaf");
    assert.equal(await directory("compact/chain/leaf").getAttribute("aria-label"), "compact/chain/leaf, 0 of 2 reviewed");
    assert.equal(await directory("compact").count(), 0);
    assert.equal(await directory("compact/chain").count(), 0);
    assert.equal(await directory("mixed").locator(':scope > .file-group > .file[data-path="mixed/direct.txt"]').count(), 1);
    assert.equal(await directory("mixed").locator(':scope > .file-group > .directory[data-directory="mixed/inner/leaf"] > .directory-row > .file-names').textContent(), "inner/leaf", "A directory with directly changed files must remain a separate row");
    await file("compact/chain/leaf/a.txt").press("ArrowLeft");
    assert.equal(await directory("compact/chain/leaf").evaluate((item) => item === document.activeElement), true);
    await directory("compact/chain/leaf").press("ArrowLeft");
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), false);
    await frame.locator("#filter").fill("compact/chain/leaf/a.txt");
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), true);
    assert.equal(await compactRow.locator(".directory-count").textContent(), "0/2");
    await markDirectory("compact/chain/leaf", true);
    assert.equal(await directory("compact/chain/leaf").getAttribute("aria-expanded"), "false");
    await frame.locator("#filter").fill("");
    assert.equal(await checkbox("compact/chain/leaf/b.txt").isChecked(), true, "Compacted directory review must include filtered-out files");
    assert.equal(await checkbox("mixed/direct.txt").isChecked(), false);
    await directory("compact/chain/leaf").press("ArrowRight");
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), true);
    await markDirectory("compact/chain/leaf", false, true);
    await file("compact/chain/leaf/b.txt").press("Enter");
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#filename").textContent(), "compact/chain/leaf/b.txt");
    await compactRow.click();
    await frame.locator("#diff").press("Shift+F7");
    await frame.locator('.file[aria-selected="true"][data-path="compact/chain/leaf/a.txt"]').waitFor();
    assert.equal(await directory("compact/chain/leaf").getAttribute("aria-expanded"), "true");
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), true);
    await markDirectory("compact/chain/leaf", true);
    await page.reload();
    await directory("compact/chain/leaf").waitFor();
    assert.equal(await directoryCheckbox("compact/chain/leaf").isChecked(), true);
    assert.equal(await directory("compact/chain/leaf").getAttribute("aria-expanded"), "false");
    assert.equal(await frame.locator("#error").isVisible(), false);

    const toggleFolders = frame.locator("#toggle-folders");
    const reviewMarksBeforeToggle = await frame.locator(".file-reviewed").evaluateAll((inputs) => inputs.map((input) => input.checked));
    const selectedBeforeToggle = await frame.locator("#filename").textContent();
    assert.equal(await toggleFolders.textContent(), "Expand all", "A partially collapsed tree should offer to expand everything");
    await toggleFolders.click();
    assert.equal(await frame.locator('.directory[aria-expanded="false"]').count(), 0);
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), true);
    assert.equal(await file("src/ui/a.txt").isVisible(), true, "Expand all must reach descendants of collapsed directories");
    assert.equal(await toggleFolders.textContent(), "Collapse all");
    await toggleFolders.press("Enter");
    assert.equal(await frame.locator('.directory[aria-expanded="true"]').count(), 0);
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), false);
    assert.equal(await file("src/ui/a.txt").isVisible(), false);
    assert.equal(await file("review-root.txt").isVisible(), true, "Collapse all must leave root-level files visible");
    assert.equal(await toggleFolders.textContent(), "Expand all");
    assert.equal(await toggleFolders.evaluate((button) => button === document.activeElement), true);
    assert.equal(await frame.locator("#filename").textContent(), selectedBeforeToggle);
    assert.deepEqual(await frame.locator(".file-reviewed").evaluateAll((inputs) => inputs.map((input) => input.checked)), reviewMarksBeforeToggle);
    await frame.locator("#filter").fill("compact/chain/leaf/a.txt");
    assert.equal(await toggleFolders.textContent(), "Collapse all");
    await toggleFolders.click();
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), false);
    await toggleFolders.click();
    assert.equal(await file("compact/chain/leaf/a.txt").isVisible(), true);
    await frame.locator("#filter").fill("");
    assert.equal(await frame.locator('.directory[aria-expanded="true"]').count(), 0, "Filtered toggles must preserve the normal tree's collapse state");
    await frame.locator("#filter").fill("review-root.txt");
    assert.equal(await toggleFolders.isDisabled(), true, "Root-level files cannot be collapsed");
    await frame.locator("#filter").fill("no-matching-file");
    assert.equal(await toggleFolders.isDisabled(), true);
    await frame.locator("#filter").fill("");
    assert.equal(await toggleFolders.isEnabled(), true);

    const emptyRepo = await mkdtemp(join(root, "unborn-"));
    await git(emptyRepo, ["init", "-b", "new-project"]);
    await page.goto("about:blank");
    await panel.close();
    panel = await createPanel({}, storage, { workingDirectory: emptyRepo });
    await page.goto(`http://127.0.0.1:${host.address().port}/`);
    await frame.locator("#diff h2", { hasText: "No changes to display" }).waitFor();
    assert.equal(panel.summary().settings.repo, emptyRepo);
    assert.equal(await frame.locator("#target").inputValue(), "new-project");
    assert.equal(await frame.locator("#base").inputValue(), "HEAD");
    assert.equal(await frame.locator("#error").isVisible(), false);
    assert.doesNotMatch(await frame.locator("body").innerText(), /\p{Script=Han}/u);
    assert.equal(panel.summary().comparison.fileCount, 0);
    assert.equal(await toggleFolders.isDisabled(), true);
    await writeFile(join(emptyRepo, "first.txt"), "not committed yet\n");
    await frame.locator("#compare").click();
    await frame.locator('.file[data-path="first.txt"]').waitFor();
    await frame.getByText("not committed yet", { exact: true }).waitFor();
    await rm(join(emptyRepo, "first.txt"));
    await git(emptyRepo, ["-c", "user.name=Canvas test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "first commit"]);
    await frame.locator("#compare").click();
    await frame.locator("#filename", { hasText: "No changes" }).waitFor();
    assert.equal(await frame.locator("#error").isVisible(), false);
    assert.equal(panel.summary().comparison.fileCount, 0);

    await page.goto("about:blank");
    await panel.close();
    panel = await createPanel({}, storage);
    await page.goto(`http://127.0.0.1:${host.address().port}/`);
    await frame.locator("#diff h2", { hasText: "No repository in this workspace" }).waitFor();
    assert.equal(await frame.locator("#compare").isDisabled(), true);
    assert.equal(panel.summary().comparison, null, "A canvas without a workspace must not silently open the last repository");
    assert.equal(await frame.locator("#error").isVisible(), false);

    assert.deepEqual(failures, []);
    console.log("PASS: aligned full-file split views, single-column navigation, stronger light/dark diff colors, positive-only file stats and persistence.");
} finally {
    await browser?.close();
    if (host) await new Promise((resolve) => host.close(resolve));
    await panel?.close();
    await rm(root, { recursive: true, force: true });
}
