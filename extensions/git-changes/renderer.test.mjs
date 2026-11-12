import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
    await writeFile(join(root, "z-binary.bin"), Buffer.from([0, 1, 2]));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(root, ["switch", "-c", "feature"]);
    lines[1] = '    public string Value = "<script>alert(1)</script>";';
    lines[49] = "    public const int Limit = 42;";
    await writeFile(join(root, "first.cs"), lines.join("\n") + "\n");
    await writeFile(join(root, "second.txt"), "new file\n");
    await writeFile(join(root, "y-align.cs"), "// before\n// new\n// middle\n// added1\n// added2\n// tail\n");
    await writeFile(join(root, "zz-empty.cs"), "");
    await writeFile(join(root, "y-deletions.cs"), retained.join("\n") + "\n");
    await writeFile(join(root, "y-empty.cs"), "");
    await writeFile(join(root, "z-binary.bin"), Buffer.from([0, 1, 3]));
    await rm(join(root, "z-deleted.cs"));
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
    await frame.locator(".change-anchor").first().waitFor();
    assert.equal(await frame.locator("#repo").inputValue(), root);
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
    assert.equal(await frame.locator(".file").count(), 8);
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
    await frame.locator("#next").click();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#next").click();
    await frame.locator(".file[aria-selected=true][data-path='second.txt']").waitFor();
    await frame.locator("#prev:not(:disabled)").waitFor();
    await frame.locator("#prev").click();
    await frame.locator(".file[aria-selected=true][data-path='first.cs']").waitFor();
    await frame.locator("#next:not(:disabled)").waitFor();
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#full-file").click();
    await frame.locator(".full-split").waitFor();
    assert.equal(await frame.locator("#view").isEnabled(), true);
    assert.equal(await frame.locator(".full-table tbody tr").count(), 60);
    assert.deepEqual(await frame.locator(".full-table .code.left .code-text").allTextContents(), baseLines);
    assert.deepEqual(await frame.locator(".full-table .code.right .code-text").allTextContents(), lines);
    assert.equal(await frame.locator("#right-label").isVisible(), true);
    assert.equal(await frame.locator("#right-scroll").isVisible(), true);
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
    assert.equal(await frame.locator("#position").textContent(), "2 / 2");
    await frame.locator("#prev").click();
    assert.equal(await frame.locator("#position").textContent(), "1 / 2");
    await frame.locator("#next").click();
    await frame.locator("#next").click();
    await frame.locator(".file[aria-selected=true][data-path='second.txt']").waitFor();
    await frame.locator("#prev:not(:disabled)").waitFor();
    assert.equal(await frame.locator(".full-split").count(), 1);
    assert.equal(await frame.locator(".full-table .code.left:not(.blank)").count(), 0);
    assert.equal(await frame.locator(".full-table .code.right.add").textContent(), "new file");
    await frame.locator("#prev").click();
    await frame.locator(".file[aria-selected=true][data-path='first.cs']").waitFor();
    await frame.locator("#next:not(:disabled)").waitFor();
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
    await frame.locator("#full-file").click();
    await frame.locator(".full-table").waitFor();
    assert.equal(await frame.locator(".full-table .code-text").textContent(), "public class Deleted {}");
    assert.match(await frame.locator("#left-label").textContent(), /Deleted file/);
    for (let i = 0; i < 50 && (!panel.summary().settings.fullFile || panel.summary().settings.selectedPath !== "z-deleted.cs"); i++) await page.waitForTimeout(20);
    assert.equal(panel.summary().settings.fullFile, true);
    await page.reload();
    await frame.locator(".full-table").waitFor();
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "true");
    await frame.locator("#view").selectOption("split");
    assert.equal(await frame.locator(".full-table .code.left.delete").textContent(), "public class Deleted {}");
    assert.equal(await frame.locator(".full-table .code.right:not(.blank)").count(), 0);
    assert.match(await frame.locator("#right-label").textContent(), /File deleted/);
    await frame.locator("[data-path='y-align.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
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
    await frame.locator("[data-path='zz-empty.cs']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.equal(await frame.locator(".full-split tr").count(), 0);
    assert.equal(await frame.locator("#position").textContent(), "0 / 0");
    await frame.locator("[data-path='z-binary.bin']").click();
    await frame.locator("#full-file:not(:disabled)").waitFor();
    assert.match(await frame.locator("#diff").textContent(), /Binary/);
    assert.doesNotMatch(await frame.locator("body").innerText(), /\p{Script=Han}/u);
    await frame.locator("#full-file").click();
    assert.equal(await frame.locator("#full-file").getAttribute("aria-pressed"), "false");

    const emptyRepo = await mkdtemp(join(root, "unborn-"));
    await git(emptyRepo, ["init", "-b", "new-project"]);
    await page.goto("about:blank");
    await panel.close();
    panel = await createPanel({}, storage, { workingDirectory: emptyRepo });
    await page.goto(`http://127.0.0.1:${host.address().port}/`);
    await frame.locator("#diff h2", { hasText: "No commits on this branch" }).waitFor();
    assert.equal(await frame.locator("#repo").inputValue(), emptyRepo);
    assert.equal(await frame.locator("#target").inputValue(), "new-project");
    assert.equal(await frame.locator("#base").inputValue(), "HEAD");
    assert.equal(await frame.locator("#error").isVisible(), false);
    assert.doesNotMatch(await frame.locator("body").innerText(), /\p{Script=Han}/u);
    assert.equal(panel.summary().comparison, null);
    await git(emptyRepo, ["-c", "user.name=Canvas test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "first commit"]);
    await frame.locator("#compare").click();
    await frame.locator("#filename", { hasText: "No changes" }).waitFor();
    assert.equal(await frame.locator("#error").isVisible(), false);
    assert.equal(panel.summary().comparison.fileCount, 0);

    assert.deepEqual(failures, []);
    console.log("PASS: aligned full-file split views, single-column navigation, stronger light/dark diff colors, positive-only file stats and persistence.");
} finally {
    await browser?.close();
    if (host) await new Promise((resolve) => host.close(resolve));
    await panel?.close();
    await rm(root, { recursive: true, force: true });
}
