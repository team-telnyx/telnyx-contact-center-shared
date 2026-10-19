const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "cc-help-context-"));
const checks = [];

async function run() {
  let server;
  let browser;
  try {
    await require("esbuild").build({
      entryPoints: [path.join(__dirname, "help-context.fixture.jsx")],
      bundle: true,
      outfile: path.join(output, "app.js"),
      platform: "browser",
      jsx: "automatic",
      alias: { "@": root },
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [{ name: "help-test-environment", setup(build) {
        build.onResolve({ filter: /^(next\/navigation|@\/components\/i18n\/use-ui-text)$/ }, args => ({ path: args.path, namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
          loader: "jsx",
          resolveDir: root,
          contents: args.path === "next/navigation" ? `
            import React, { createContext, useContext, useState } from "react";
            const Navigation = createContext("/admin/system/schedules");
            export const usePathname = () => useContext(Navigation);
            window.fixture = {};
            export function NavigationFixture({ children }) {
              const [pathname, navigate] = useState("/admin/system/schedules");
              window.fixture.navigate = navigate;
              return <Navigation.Provider value={pathname}>{children}</Navigation.Provider>;
            }
          ` : "const text = s => s; export const useUiText = () => text; export const UiText = ({ children }) => children;",
        }));
      } }],
    });
    server = http.createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/app.js"
        ? fs.readFileSync(path.join(output, "app.js"))
        : '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await require("puppeteer").launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH }
        : fs.existsSync(macChrome) ? { executablePath: macChrome } : {}),
      args: process.env.CI ? ["--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.fixture?.openHelp === "function");
    const sheet = "[data-context-help-sheet='true']";
    const article = `${sheet} a[target='contact-center-help']`;
    const expectArticle = async href => {
      await page.waitForFunction((selector, expected) => document.querySelector(selector)?.getAttribute("href") === expected, {}, article, href);
      // Portal content is committed before Radix registers its dismiss layer.
      // Let that effect settle before sending Escape in the same frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok((await page.$eval(`${sheet} [data-slot='sheet-title']`, element => element.textContent)).trim());
    };

    await page.focus("#screen-control");
    await page.keyboard.press("F1");
    await expectArticle("/help/administration/system/schedules");
    assert.equal(await page.evaluate(() => document.activeElement.id), "screen-control", "opening Help must preserve editing focus");
    checks.push("F1 opens specific screen help without stealing focus");

    await page.evaluate(() => window.fixture.navigate("/admin/queues"));
    await expectArticle("/help/administration/queues");
    await page.focus("#queue-field");
    const fieldHref = "/help/administration/queues#maximum-wait-time";
    await expectArticle(fieldHref);
    assert.match(await page.$eval(sheet, element => element.textContent), /Field help/);
    checks.push("open help follows field focus");

    await page.focus(article);
    await expectArticle(fieldHref);
    await page.keyboard.press("F1");
    await expectArticle(fieldHref);
    checks.push("focus and repeated F1 inside Help preserve the selected topic");

    await page.focus("#schedule-control");
    await expectArticle("/help/administration/call-flows/nodes/schedules");
    await page.focus("#invite-control");
    await expectArticle("/help/administration/call-flows/nodes/agent-assist#allow-assistant-invitations");
    checks.push("nearest feature context wins over its parent");

    await page.evaluate(() => window.fixture.navigate("/admin/system/settings/ai-copilot"));
    await expectArticle("/help/administration/system/ai-copilot");
    await page.focus("#invalid-context");
    await expectArticle("/help/administration/system/ai-copilot");
    checks.push("route changes clear stale context and unknown IDs fall back to the current screen");

    await page.evaluate(() => window.fixture.openHelp("profile.devices"));
    await expectArticle("/help/mobile");
    await page.focus(article);
    await page.keyboard.press("Escape");
    await page.waitForSelector(sheet, { hidden: true });
    await page.focus("#screen-control");
    await page.keyboard.press("F1");
    await expectArticle("/help/administration/system/ai-copilot");
    checks.push("explicit topics, Escape and reopening use the correct destination");

    await page.keyboard.press("Escape");
    await page.waitForSelector(sheet, { hidden: true });
    await page.click("#modal-trigger");
    await page.focus("#modal-control");
    await page.keyboard.press("F1");
    await expectArticle("/help/webrtc-phone/devices");
    await page.focus(article);
    assert.equal(await page.$eval(article, element => element === document.activeElement), true, "Help in a modal must remain keyboard accessible");
    assert.equal(await page.$eval(sheet, element => Boolean(element.closest('[aria-hidden="true"]'))), false);
    await page.keyboard.press("Escape");
    await page.waitForSelector(sheet, { hidden: true });
    assert.ok(await page.$("#modal-control"), "Escape closes Help before the underlying dialog");
    checks.push("F1 in a modal remains accessible and Escape preserves the underlying dialog");
    assert.deepEqual(errors, [], "browser runtime errors");
    console.log(JSON.stringify({ passed: true, checks }));
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(output, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
