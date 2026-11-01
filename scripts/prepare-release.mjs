import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { assertVersions, releaseTag, selectRelease, versionFiles, writeVersions } from "./release-version.mjs";

export function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function ancestor(root, older, newer) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: root });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Git ancestry check failed: ${result.stderr}`);
}

export function readTags(root) {
  return git(root, "tag", "--list", "v*").split("\n").filter(Boolean).map((name) => {
    const contents = git(root, "for-each-ref", "--format=%(contents)", `refs/tags/${name}`);
    if (!contents.startsWith("simple-media-overlay-release\n")) return { name };
    const metadata = JSON.parse(contents.slice(contents.indexOf("\n") + 1));
    releaseTag(name, metadata.channel);
    if (metadata.target !== `${semver.major(name.slice(1))}.${semver.minor(name.slice(1))}.${semver.patch(name.slice(1))}`) {
      throw new Error(`Tag ${name} has an inconsistent target`);
    }
    if (!/^[a-f0-9]{40}$/.test(metadata.source) || !ancestor(root, metadata.source, `${name}^{commit}`)) {
      throw new Error(`Tag ${name} has an invalid source`);
    }
    return { ...metadata, name };
  });
}

export function prepareRelease(root, source, channel) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Release source must be a full commit SHA");
  if (git(root, "rev-parse", "HEAD") !== source) throw new Error("Checkout must match the tested source");
  if (git(root, "status", "--porcelain", "--untracked-files=no")) throw new Error("Release worktree is not clean");
  const plan = JSON.parse(readFileSync(resolve(root, "release-plan.json"), "utf8"));
  const tags = readTags(root);
  const selection = selectRelease({ plan, tags, source, channel });
  if (selection.reuse) {
    git(root, "checkout", "--detach", selection.tag);
    assertVersions(root, selection.version);
    return selection;
  }
  assertVersions(root, plan.base);
  if (channel === "stable") {
    const development = tags.filter((tag) => tag.channel === "development"
      && tag.target === plan.target && tag.base === plan.base)
      .sort((a, b) => semver.rcompare(a.name.slice(1), b.name.slice(1)))[0];
    if (!development || !ancestor(root, development.source, source)) {
      throw new Error("Stable promotion requires the latest development prerelease source to be merged into master");
    }
  }
  git(root, "checkout", "--detach", source);
  writeVersions(root, selection.version);
  git(root, "add", "--", ...versionFiles);
  git(root, "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-m", `chore: release ${selection.version} [skip ci]`);
  const metadata = { source, channel, base: plan.base, target: plan.target };
  git(root, "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "tag", "-a", selection.tag, "-m", `simple-media-overlay-release\n${JSON.stringify(metadata)}`);
  return selection;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = prepareRelease(process.cwd(), process.env.RELEASE_SOURCE, process.env.RELEASE_CHANNEL);
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(result));
}
