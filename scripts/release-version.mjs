import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { parse as parseToml } from "smol-toml";

export const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

export function stableVersion(value) {
  const parsed = semver.parse(value);
  if (!parsed || parsed.version !== value || parsed.prerelease.length || parsed.build.length) {
    throw new Error(`Expected a canonical stable SemVer version, got ${value}`);
  }
  return parsed.version;
}

export function releaseTag(name, channel) {
  const version = name?.startsWith("v") ? semver.parse(name.slice(1)) : null;
  if (!version || `v${version.version}` !== name || version.build.length) {
    throw new Error(`Invalid release tag: ${name}`);
  }
  const development = version.prerelease.length === 2
    && version.prerelease[0] === "dev"
    && Number.isSafeInteger(version.prerelease[1])
    && version.prerelease[1] > 0;
  if (!["development", "stable"].includes(channel)
    || (channel === "development" ? !development : version.prerelease.length !== 0)) {
    throw new Error(`Release channel ${channel} does not match ${name}`);
  }
  return version;
}

export function selectRelease({ plan, tags, source, channel }) {
  stableVersion(plan.base);
  stableVersion(plan.target);
  if (!semver.gt(plan.target, plan.base)) {
    throw new Error("Release target must be greater than its stable baseline");
  }
  if (!["development", "stable"].includes(channel)) {
    throw new Error(`Unknown release channel: ${channel}`);
  }

  const retry = tags.filter((tag) => tag.source === source && tag.channel === channel);
  if (retry.length > 1) throw new Error("Multiple release tags claim the same source and channel");
  if (retry.length) {
    const tag = retry[0];
    releaseTag(tag.name, channel);
    if (tag.base !== plan.base || tag.target !== plan.target) {
      throw new Error("Existing tag does not match the source release plan");
    }
    return { tag: tag.name, version: tag.name.slice(1), reuse: true };
  }

  // All stable tags are reserved, even if their release failed to publish.
  const stableTags = tags.map((tag) => semver.parse(tag.name.slice(1)))
    .filter((version, index) => version && tags[index].name === `v${version.version}`
      && !version.prerelease.length && !version.build.length);
  const latest = stableTags.sort(semver.rcompare)[0]?.version;
  if (latest !== plan.base) {
    throw new Error(`Release plan baseline ${plan.base} must equal highest stable tag ${latest}; synchronize and open the next cycle`);
  }

  let version = plan.target;
  if (channel === "development") {
    const counters = tags.map((tag) => semver.parse(tag.name.slice(1)))
      .filter((parsed) => parsed && parsed.major === semver.major(plan.target)
        && parsed.minor === semver.minor(plan.target) && parsed.patch === semver.patch(plan.target)
        && parsed.prerelease.length === 2 && parsed.prerelease[0] === "dev"
        && Number.isSafeInteger(parsed.prerelease[1]) && parsed.prerelease[1] > 0)
      .map((parsed) => parsed.prerelease[1]);
    const counter = Math.max(0, ...counters) + 1;
    if (!Number.isSafeInteger(counter)) throw new Error("Development counter overflow");
    version = `${plan.target}-dev.${counter}`;
  }
  const tag = `v${version}`;
  if (tags.some((existing) => existing.name === tag)) {
    throw new Error(`Tag ${tag} already exists for a different source; never overwrite it`);
  }
  return { tag, version, reuse: false };
}

function versionDocuments(root) {
  const text = Object.fromEntries(versionFiles.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const pkg = JSON.parse(text["package.json"]);
  const lock = JSON.parse(text["package-lock.json"]);
  const tauri = JSON.parse(text["src-tauri/tauri.conf.json"]);
  const cargo = parseToml(text["src-tauri/Cargo.toml"]);
  const cargoLock = parseToml(text["src-tauri/Cargo.lock"]);
  const entries = cargoLock.package.filter((entry) => entry.name === cargo.package.name && !entry.source);
  if (entries.length !== 1) throw new Error("Cargo.lock must contain exactly one local application package");
  return { text, pkg, lock, tauri, cargo, cargoEntry: entries[0] };
}

export function assertVersions(root, expected) {
  const { pkg, lock, tauri, cargo, cargoEntry } = versionDocuments(root);
  const values = [pkg.version, lock.version, lock.packages[""].version, tauri.version,
    cargo.package.version, cargoEntry.version];
  if (values.some((version) => version !== expected)) {
    throw new Error(`Version-bearing files must all be ${expected}; found ${values.join(", ")}`);
  }
}

export function writeVersions(root, version) {
  if (semver.valid(version) !== version) throw new Error(`Invalid application version: ${version}`);
  const { text, pkg, lock, tauri, cargo } = versionDocuments(root);
  pkg.version = lock.version = lock.packages[""].version = tauri.version = version;
  for (const [path, data] of [["package.json", pkg], ["package-lock.json", lock], ["src-tauri/tauri.conf.json", tauri]]) {
    writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`);
  }
  const manifest = text["src-tauri/Cargo.toml"].replace(
    /(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${version}"`,
  );
  const blocks = text["src-tauri/Cargo.lock"].split(/(?=^\[\[package\]\])/m);
  const cargoLock = blocks.map((block) => {
    if (!block.startsWith("[[package]]")) return block;
    const entry = parseToml(block).package[0];
    return entry.name === cargo.package.name && !entry.source
      ? block.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
      : block;
  }).join("");
  writeFileSync(join(root, "src-tauri/Cargo.toml"), manifest);
  writeFileSync(join(root, "src-tauri/Cargo.lock"), cargoLock);
  assertVersions(root, version);
}
