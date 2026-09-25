import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  entryPoints: [resolve("src/cobrowse/capture.js")],
  outfile: resolve("public/widget/v1/cobrowse.js"),
  alias: { "@rrweb/record": resolve("node_modules/@rrweb/record/dist/record.js") },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "none",
  sourcemap: false,
});
