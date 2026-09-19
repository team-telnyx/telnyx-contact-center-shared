import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildInfoFromSource, createBuildInfo, dockerBuildMetadata, packageVersion } from "../scripts/lib/build-info.mjs";
import { releaseSections, syncReleaseFiles } from "../scripts/release.mjs";
import { versionInfoText } from "../lib/app-version.mjs";
import { composeUp } from "../deploy/cli/lib/compose.mjs";
import { buildAndPackageImage } from "../deploy/cli/lib/cloud-deploy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dirs = [];
const now = new Date("2026-09-14T12:34:56.000Z");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(version = "1.0.0", withGit = true) {
  const root = mkdtempSync(join(tmpdir(), "cc-version-test-")); dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  if (withGit) {
    git(root, "init", "-q");
    git(root, "add", "package.json");
    git(root, "-c", "user.name=Version Test", "-c", "user.email=version@example.test", "commit", "-qm", "Initial source");
  }
  return root;
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a clean matching tag identifies a stable release, and subsequent commits are development builds", () => {
  const root = fixture(); git(root, "tag", "v1.0.0");
  const info = createBuildInfo({ root, env: {}, now });
  assert.equal(info.channel, "stable"); assert.equal(info.displayVersion, "1.0.0");
  assert.equal(info.commit, git(root, "rev-parse", "HEAD"));
  assert.equal(info.builtAt, now.toISOString()); assert.equal(info.dirty, false);
  git(root, "-c", "user.name=Version Test", "-c", "user.email=version@example.test", "commit", "--allow-empty", "-qm", "Next change");
  const next = createBuildInfo({ root, env: {}, now });
  assert.equal(next.channel, "development"); assert.equal(next.displayVersion, "1.0.0-dev");
  assert.notEqual(next.commit, info.commit); assert.equal(next.tag, null);
});

test("tracked and untracked local modifications cannot masquerade as the tagged release", () => {
  for (const path of ["package.json", "new-feature.js"]) {
    const root = fixture(); git(root, "tag", "v1.0.0");
    writeFileSync(join(root, path), path === "package.json" ? '{"version":"1.0.0", "changed":true}' : "new feature");
    const info = createBuildInfo({ root, env: {}, now });
    assert.equal(info.channel, "development"); assert.equal(info.dirty, true);
    assert.match(info.buildId, /\.dirty$/); assert.equal(info.tag, null);
  }
});

test("candidate tags retain SemVer and report the prerelease channel", () => {
  const root = fixture("1.1.0-rc.1"); git(root, "tag", "v1.1.0-rc.1");
  const info = createBuildInfo({ root, env: {}, now });
  assert.equal(info.channel, "prerelease"); assert.equal(info.displayVersion, "1.1.0-rc.1");
});

test("each build carries its timestamp and host recapture ignores a previously exported snapshot", () => {
  const root = fixture(); git(root, "tag", "v1.0.0");
  const first = createBuildInfo({ root, env: {}, now });
  const later = createBuildInfo({ root, env: {}, now: new Date(now.getTime() + 1000) });
  assert.notEqual(first.buildId, later.buildId);
  writeFileSync(join(root, "new-feature.js"), "new local work");
  const fresh = JSON.parse(execFileSync(process.execPath, [resolve(repoRoot, "scripts/build-info.mjs")], {
    cwd: root, env: { ...process.env, CC_BUILD_INFO: JSON.stringify(first) }, encoding: "utf8",
  }));
  assert.equal(fresh.dirty, true); assert.equal(fresh.channel, "development"); assert.equal(fresh.tag, null);
});

test("archives without Git never invent a source revision or stable channel", () => {
  const info = createBuildInfo({ root: fixture("1.0.0", false), env: {}, now });
  assert.equal(info.channel, "development"); assert.equal(info.commit, null);
  assert.equal(info.dirty, null); assert.match(info.buildId, /\+unknown\.build\./);
});

test("Docker metadata round-trips from the host with an allowlist and package-version validation", () => {
  const root = fixture(); git(root, "tag", "v1.0.0");
  const original = createBuildInfo({ root, env: {}, now });
  const context = fixture("1.0.0", false);
  const info = createBuildInfo({ root: context, env: { CC_BUILD_INFO: JSON.stringify({ ...original, secret: "never expose" }) } });
  assert.deepEqual(info, original); assert.equal(Object.hasOwn(info, "secret"), false);
  const docker = dockerBuildMetadata(info);
  assert.equal(docker.labels["org.opencontainers.image.version"], "1.0.0");
  assert.deepEqual(JSON.parse(docker.args.CC_BUILD_INFO), info);
  writeFileSync(join(context, "package.json"), '{"version":"1.1.0"}');
  assert.throws(() => createBuildInfo({ root: context, env: { CC_BUILD_INFO: JSON.stringify(original) } }), /does not match/);
});

test("invalid or contradictory metadata fails rather than silently mislabeling a release", () => {
  const base = { version: "1.0.0", commit: "a".repeat(40), tag: "v1.0.0", dirty: false, builtAt: now.toISOString() };
  for (const invalid of [{ version: "01.0.0" }, { version: "1.0.0-01" }, { version: "1.0.0+custom" },
    { commit: "not-a-sha" }, { tag: "v2.0.0" }, { dirty: true }, { commit: null }, { builtAt: "bad date" }]) {
    assert.throws(() => buildInfoFromSource({ ...base, ...invalid }));
  }
});

test("compiled server and client keep the original build when the runtime environment changes", async () => {
  const info = createBuildInfo({ root: fixture(), env: {}, now });
  const define = { "process.env.NEXT_PUBLIC_CC_BUILD_INFO": JSON.stringify(JSON.stringify(info)) };
  const [server, client] = await Promise.all([
    build({ entryPoints: [resolve(repoRoot, "app/api/version/route.js")], bundle: true, write: false, platform: "node", format: "esm", alias: { "@": repoRoot }, define }),
    build({ entryPoints: [resolve(repoRoot, "lib/app-version.mjs")], bundle: true, write: false, platform: "browser", format: "esm", define }),
  ]);
  const previous = process.env.NEXT_PUBLIC_CC_BUILD_INFO;
  process.env.NEXT_PUBLIC_CC_BUILD_INFO = JSON.stringify({ version: "99.0.0" });
  try {
    const route = await import(`data:text/javascript;base64,${Buffer.from(server.outputFiles[0].text).toString("base64")}`);
    const browser = await import(`data:text/javascript;base64,${Buffer.from(client.outputFiles[0].text).toString("base64")}`);
    const response = route.GET();
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), info); assert.deepEqual(browser.APP_BUILD, info);
    assert.match(browser.versionInfoText(), new RegExp(info.commit));
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CC_BUILD_INFO;
    else process.env.NEXT_PUBLIC_CC_BUILD_INFO = previous;
  }
});

test("copyable information includes the complete identity, and unknown information stays explicit", () => {
  const info = createBuildInfo({ root: fixture("1.0.0", false), env: {}, now });
  assert.match(versionInfoText(info), /Commit: Unavailable/);
  assert.match(versionInfoText(info), /Working tree: Unknown/);
  assert.match(versionInfoText(null), /unavailable/);
});

function releaseFixture() {
  const root = fixture();
  mkdirSync(join(root, "content/help"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Product\n<!-- app-version:start -->\n<!-- app-version:end -->\n");
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2026-09-14\n\n### Added\n\n- Version information.\n\n## Historical changes\n\nOld notes.\n");
  syncReleaseFiles({ root });
  git(root, "add", ".");
  git(root, "-c", "user.name=Version Test", "-c", "user.email=version@example.test", "commit", "-qm", "Release notes");
  return root;
}

test("release notes share one source, preserve historical entries, and reject generated-file drift", () => {
  const root = releaseFixture();
  const release = syncReleaseFiles({ root, check: true });
  assert.match(release.body, /Version information/); assert.doesNotMatch(release.body, /Old notes/);
  assert.match(readFileSync(join(root, "content/help/changelog.mdx"), "utf8"), /Old notes/);
  writeFileSync(join(root, "content/help/changelog.mdx"), "Stale notes");
  assert.throws(() => syncReleaseFiles({ root, check: true }), /out of date/);
});

test("release publication requires the exact matching tag at the current clean commit", () => {
  const root = releaseFixture(); git(root, "tag", "v1.0.0");
  assert.equal(syncReleaseFiles({ root, check: true, tag: "v1.0.0" }).version, "1.0.0");
  assert.throws(() => syncReleaseFiles({ root, check: true, tag: "v2.0.0" }), /does not match/);
  git(root, "-c", "user.name=Version Test", "-c", "user.email=version@example.test", "commit", "--allow-empty", "-qm", "Moved on");
  assert.throws(() => syncReleaseFiles({ root, check: true, tag: "v1.0.0" }), /checked-out commit/);
});

test("invalid release dates, duplicate versions, and missing current notes are rejected", () => {
  for (const text of ["## [1.0.0] - 2026-02-30\nNotes", "## [1.0.0] - 2026-09-14\n", "## [1.0.0] - 2026-09-14\nNotes\n## [1.0.0] - 2026-09-15\nNotes"]) {
    assert.throws(() => releaseSections(text));
  }
  const root = releaseFixture();
  writeFileSync(join(root, "package.json"), '{"version":"1.1.0"}');
  assert.throws(() => syncReleaseFiles({ root, check: true }), /first changelog release/);
});

test("the deployment wizard supplies the same source identity to Compose, Docker labels, and the artifact manifest", async () => {
  const root = fixture(); git(root, "tag", "v1.0.0");
  const cwd = join(root, "docker/production"); mkdirSync(cwd, { recursive: true });
  const outDir = mkdtempSync(join(tmpdir(), "cc-version-artifact-")); dirs.push(outDir);
  let compose;
  await composeUp({ cwd, execImpl: async (command, args, options) => { compose = { command, args, options }; } });
  const composeInfo = JSON.parse(compose.options.env.CC_BUILD_INFO);
  assert.equal(composeInfo.channel, "stable"); assert.equal(composeInfo.version, "1.0.0");
  let docker;
  const result = await buildAndPackageImage({ repoRoot: root, imageTag: "cc:fixture", outDir,
    execImpl: async (command, args) => {
      if (command === "docker") docker = args;
      else writeFileSync(join(outDir, "image.tar.zst"), Buffer.alloc(2 * 1024 * 1024));
      return { stdout: "", stderr: "" };
    },
  });
  const info = JSON.parse(docker.find((arg) => arg.startsWith("CC_BUILD_INFO=")).slice("CC_BUILD_INFO=".length));
  assert.deepEqual(result.manifest.build, info); assert.equal(result.manifest.git_sha, composeInfo.commit);
  assert.ok(docker.includes(`org.opencontainers.image.revision=${info.commit}`));
  assert.equal(result.manifest.built_at, info.builtAt);
});

test("the repository release notes and README are synchronized", () => {
  assert.equal(syncReleaseFiles({ root: repoRoot, check: true }).version, packageVersion(repoRoot));
});
