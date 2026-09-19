import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SemVer without build metadata: build identity is added separately below.
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function gitOutput(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function packageVersion(root) {
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (!RELEASE_VERSION.test(version)) throw new Error("package.json must contain a valid release SemVer version");
  return version;
}

export function buildInfoFromSource({ version, commit = null, tag = null, dirty = null, builtAt }) {
  if (!RELEASE_VERSION.test(version)) throw new Error("Invalid application version");
  if (commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid build commit");
  if (dirty !== null && typeof dirty !== "boolean") throw new Error("Invalid working tree status");
  if (tag !== null && tag !== `v${version}`) throw new Error("Release tag does not match package.json version");
  if (tag && (!commit || dirty !== false)) throw new Error("A release requires a known commit and clean working tree");
  if (typeof builtAt !== "string" || !Number.isFinite(Date.parse(builtAt))) throw new Error("Invalid build date");
  const channel = tag ? (version.includes("-") ? "prerelease" : "stable") : "development";
  const normalizedBuiltAt = new Date(builtAt).toISOString();
  const shortCommit = commit?.slice(0, 12) || null;
  const suffix = tag ? "" : `${version.includes("-") ? "." : "-"}dev`;
  const metadata = [shortCommit ? `sha.${shortCommit}` : "unknown", `build.${normalizedBuiltAt.replace(/[^0-9A-Za-z]/g, "")}`, dirty ? "dirty" : null].filter(Boolean).join(".");
  return { version, displayVersion: `${version}${suffix}`, buildId: `${version}${suffix}+${metadata}`, channel,
    commit, shortCommit, tag, dirty, builtAt: normalizedBuiltAt };
}

export function createBuildInfo({ root = process.cwd(), env = process.env, now = new Date() } = {}) {
  const version = packageVersion(root);
  // The Docker context excludes .git. Its builder supplies a snapshot created
  // on the host, then Next embeds the same allowlisted values in both bundles.
  if (env.CC_BUILD_INFO) {
    const source = JSON.parse(env.CC_BUILD_INFO);
    if (source.version !== version) throw new Error("Build metadata version does not match package.json");
    return buildInfoFromSource(source);
  }
  const commit = gitOutput(root, ["rev-parse", "HEAD"]);
  const status = commit ? gitOutput(root, ["status", "--porcelain", "--untracked-files=normal"]) : null;
  const dirty = status === null ? null : status.length > 0;
  const tags = gitOutput(root, ["tag", "--points-at", "HEAD"])?.split("\n") || [];
  const tag = dirty === false && tags.includes(`v${version}`) ? `v${version}` : null;
  return buildInfoFromSource({ version, commit, tag, dirty, builtAt: now.toISOString() });
}

export function dockerBuildMetadata(info) {
  return {
    args: { CC_BUILD_INFO: JSON.stringify(info) },
    labels: {
      "org.opencontainers.image.version": info.displayVersion,
      "org.opencontainers.image.revision": info.commit || "unknown",
      "org.opencontainers.image.created": info.builtAt,
    },
  };
}
