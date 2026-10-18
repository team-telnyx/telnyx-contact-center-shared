import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import puppeteer from "puppeteer";

const source = await readFile(new URL("../../lib/ai/avatar-preview.mjs", import.meta.url), "utf8");
const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME_PATH || await access(mac).then(() => mac, () => undefined);
const browser = await puppeteer.launch({ headless: true, executablePath, args: process.env.CI ? ["--no-sandbox"] : [] });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="preview"></canvas>');
  const result = await page.evaluate(async source => {
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const { drawAvatarPreview } = await import(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const input = document.createElement("canvas"); input.width = input.height = 256;
    const ctx = input.getContext("2d"); ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, 256, 256);
    const blob = await new Promise(resolve => input.toBlob(resolve, "image/png"));
    const output = document.getElementById("preview");
    const drawn = await drawAvatarPreview(output, new File([blob], "avatar.png", { type: "image/png" }));
    const pixel = [...output.getContext("2d").getImageData(0, 0, 1, 1).data];
    const rejected = [];
    for (const type of ["text/html", "image/svg+xml", "image/png"]) {
      try { await drawAvatarPreview(output, new File(['<img src=x onerror="window.executed=true">'], "invalid", { type })); rejected.push(false); }
      catch { rejected.push(true); }
    }
    return { drawn, width: output.width, height: output.height, pixel, rejected, executed: Boolean(window.executed) };
  }, source);
  assert.deepEqual(result, { drawn: true, width: 160, height: 160, pixel: [0, 255, 0, 255], rejected: [true, true, true], executed: false });
  console.log("Avatar raster preview: real PNG pixels rendered; HTML, SVG and mislabeled HTML rejected.");
} finally {
  await browser.close();
}
