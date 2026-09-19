import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOutput, packageVersion, RELEASE_VERSION } from "./lib/build-info.mjs";

export function releaseSections(changelog) {
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)];
  const seen = new Set();
  return headings.map((match, index) => {
    const [, version, date] = match;
    if (!RELEASE_VERSION.test(version) || seen.has(version)) throw new Error(`Invalid or duplicate release: ${version}`);
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error(`Invalid release date: ${date}`);
    seen.add(version);
    const tail = changelog.slice(match.index + match[0].length, headings[index + 1]?.index);
    // Historical, unversioned entries are retained in the changelog but are
    // never included in the first official GitHub Release.
    const body = tail.split(/^## Historical changes/m)[0].trim();
    if (!body) throw new Error(`Release ${version} has no notes`);
    return { version, date, body };
  });
}

export function syncReleaseFiles({ root = process.cwd(), check = false, tag = null } = {}) {
  const version = packageVersion(root);
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const releases = releaseSections(changelog);
  const current = releases.find((entry) => entry.version === version);
  if (!current || releases[0] !== current) throw new Error("The first changelog release must match package.json");
  if (tag && tag !== `v${version}`) throw new Error("Tag does not match package.json");
  const badge = `[![Version ${version}](https://img.shields.io/badge/version-${version.replaceAll("-", "--")}-00C389)](https://github.com/team-telnyx/telnyx-contact-center-shared/releases)`;
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const badgeBlock = `<!-- app-version:start -->\n${badge}\n<!-- app-version:end -->`;
  if (!readme.includes("<!-- app-version:start -->")) throw new Error("README version marker is missing");
  const help = `---\ntitle: Changelog\ndescription: Release notes for Telnyx Contact Center.\naudiences: [agent, supervisor, admin, owner]\nkeywords: [changelog, release notes, changes, version]\nowner: contact-center\nlastReviewed: ${current.date}\n---\n\n{/* Generated from CHANGELOG.md by yarn release:sync. */}\n\n${changelog.replace(/^# Changelog\s*\n/, "").trim()}\n`;
  const generated = {
    "README.md": readme.replace(/<!-- app-version:start -->[\s\S]*?<!-- app-version:end -->/, badgeBlock),
    "content/help/changelog.mdx": help,
  };
  for (const [path, expected] of Object.entries(generated)) {
    if (check) {
      if (readFileSync(resolve(root, path), "utf8") !== expected) throw new Error(`${path} is out of date; run yarn release:sync`);
    } else writeFileSync(resolve(root, path), expected);
  }
  if (tag) {
    const commit = gitOutput(root, ["rev-parse", "HEAD"]);
    if (!commit || gitOutput(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit) throw new Error("Release tag must point to the checked-out commit");
    if (gitOutput(root, ["status", "--porcelain"]) !== "") throw new Error("Release requires a clean working tree");
  }
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = "check", ...args] = process.argv.slice(2);
    if (!["sync", "check", "notes"].includes(command) || (args.length && (args.length !== 2 || args[0] !== "--tag" || !args[1]))) {
      throw new Error("Usage: node scripts/release.mjs sync|check|notes [--tag vX.Y.Z]");
    }
    const release = syncReleaseFiles({ check: command !== "sync", tag: args[1] });
    console.log(command === "notes" ? `# Telnyx Contact Center ${release.version}\n\n${release.body}` : `Release ${release.version}: ${command === "sync" ? "files synchronized" : "checks passed"}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
