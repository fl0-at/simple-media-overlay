import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertVersions, releaseTag, selectRelease, writeVersions } from "./release-version.mjs";
import { qualifies } from "./release-eligibility.mjs";
import { git, prepareRelease, readTags } from "./prepare-release.mjs";
import { validateRelease } from "./validate-release.mjs";
import { collectRelease } from "./collect-release.mjs";

const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smo-release-test-"));
  temporary.push(root);
  mkdirSync(join(root, "src-tauri"));
  const json = (path, data) => writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`);
  json("package.json", { name: "simple-media-overlay", version: "1.0.7" });
  json("package-lock.json", { version: "1.0.7", packages: { "": { version: "1.0.7" } } });
  json("src-tauri/tauri.conf.json", { version: "1.0.7" });
  json("release-plan.json", { base: "1.0.7", target: "1.0.8" });
  writeFileSync(join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "simple-media-overlay"\nversion = "1.0.7"\n\n[dependencies]\nother = { version = "9.0.0" }\n');
  writeFileSync(join(root, "src-tauri/Cargo.lock"),
    '# Cargo lockfile\nversion = 4\n\n[[package]]\nname = "other"\nversion = "9.0.0"\nsource = "registry+https://example.test"\n\n[[package]]\nname = "simple-media-overlay"\nversion = "1.0.7"\ndependencies = ["other"]\n');
  git(root, "init", "--initial-branch=master");
  git(root, "config", "user.name", "Release test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "core.autocrlf", "false");
  commit(root, "baseline");
  git(root, "tag", "v1.0.7");
  return root;
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

describe("explicit stable targets", () => {
  const source = "a".repeat(40);
  const initial = { base: "1.0.7", target: "1.0.8" };
  const choose = (plan = initial, tags = [{ name: "v1.0.7" }], channel = "development") =>
    selectRelease({ plan, tags, source, channel });

  it.each(["1.0.8", "1.1.0", "2.0.0"])("starts patch/minor/major target %s at dev.1", (target) => {
    expect(choose({ ...initial, target }).version).toBe(`${target}-dev.1`);
  });

  it("increments the counter, not the patch, and uses numeric SemVer ordering", () => {
    const tags = ["v1.0.7", "v1.0.8-dev.2", "v1.0.8-dev.10", "v1.1.0-dev.99"].map((name) => ({ name }));
    expect(choose(initial, tags).version).toBe("1.0.8-dev.11");
  });

  it("promotes without bumping the target again", () => {
    expect(choose(initial, [{ name: "v1.0.7" }], "stable").version).toBe("1.0.8");
  });

  it("reserves unpublished tags and stops a closed cycle", () => {
    expect(() => choose(initial, [{ name: "v1.0.8" }])).toThrow(/synchronize/);
    expect(choose({ base: "1.0.8", target: "1.0.9" }, [{ name: "v1.0.8" }]).version).toBe("1.0.9-dev.1");
  });

  it.each(["development", "stable"])("reuses the exact %s tag on rerun even after stable promotion", (channel) => {
    const name = channel === "development" ? "v1.0.8-dev.3" : "v1.0.8";
    const tags = [{ name: "v1.0.8" }, { name, source, channel, ...initial }];
    expect(choose(initial, tags, channel)).toEqual({ tag: name, version: name.slice(1), reuse: true });
  });

  it("rejects conflicting duplicate provenance and noncanonical targets", () => {
    expect(() => choose(initial, [
      { name: "v1.0.7" },
      { name: "v1.0.8-dev.1", source, channel: "development", base: "1.0.6", target: "1.0.8" },
    ])).toThrow(/does not match/);
    expect(() => choose({ ...initial, target: "v1.0.8" })).toThrow(/canonical/);
    expect(() => choose({ ...initial, target: "1.0.8-dev.1" })).toThrow(/stable SemVer/);
    expect(() => choose({ ...initial, target: "1.0.7" })).toThrow(/greater/);
  });

  it("reserves a development tag even without managed provenance", () => {
    expect(choose(initial, [{ name: "v1.0.7" }, { name: "v1.0.8-dev.1" }]).tag).toBe("v1.0.8-dev.2");
  });

  it("rejects two tags claiming the same source and channel instead of choosing one", () => {
    const tags = [1, 2].map((counter) => ({
      name: `v1.0.8-dev.${counter}`, source, channel: "development", ...initial,
    }));
    expect(() => choose(initial, tags)).toThrow(/Multiple release tags/);
  });

  it.each([["v1.0.8-dev.1", "stable"], ["v1.0.8", "development"], ["v1.0.8-1", "development"],
    ["v1.0.8-dev.0", "development"], ["v1.0.8+build", "stable"]])("rejects mismatched tag %s", (tag, channel) => {
    expect(() => releaseTag(tag, channel)).toThrow();
  });

  it("qualifies the workflow-only rollout but skips documentation-only changes", () => {
    expect(qualifies([".github/workflows/release.yml", "VERSIONING.md"])).toBe(true);
    expect(qualifies(["README.md", "VERSIONING.md", ".gitignore", "docs/release.txt"])).toBe(false);
    expect(qualifies(["src-tauri/Cargo.lock"])).toBe(true);
    expect(qualifies(["app/overlay/MediaControls.tsx"])).toBe(true);
  });
});

describe("version commits and promotion in a real temporary Git repository", () => {
  it("updates every version, preserves dependency versions, and detects a stale Cargo lock", () => {
    const root = fixture();
    writeVersions(root, "1.0.8-dev.1");
    assertVersions(root, "1.0.8-dev.1");
    expect(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8")).toContain('other = { version = "9.0.0" }');
    expect(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8")).toContain('name = "other"\nversion = "9.0.0"');
    writeFileSync(join(root, "src-tauri/tauri.conf.json"), '{"version":"1.0.7"}');
    expect(() => assertVersions(root, "1.0.8-dev.1")).toThrow(/Version-bearing/);
  });

  it("handles repeated develop pushes, both reruns, a regular master merge, and the next cycle without moving branches", () => {
    const root = fixture();
    git(root, "checkout", "-b", "develop");
    writeFileSync(join(root, "app.txt"), "first change");
    const first = commit(root, "ci: release workflow rollout");
    expect(prepareRelease(root, first, "development").tag).toBe("v1.0.8-dev.1");
    expect(git(root, "rev-parse", "develop")).toBe(first);
    git(root, "checkout", "--detach", first);
    expect(prepareRelease(root, first, "development").reuse).toBe(true);
    git(root, "checkout", "develop");
    writeFileSync(join(root, "app.txt"), "second change");
    const second = commit(root, "fix: second change");
    expect(prepareRelease(root, second, "development").tag).toBe("v1.0.8-dev.2");
    git(root, "update-ref", "refs/remotes/origin/develop", second);
    expect(validateRelease(root, { tag: "v1.0.8-dev.2", channel: "development", source: second }).source).toBe(second);
    expect(() => validateRelease(root, { tag: "v1.0.8-dev.2", channel: "development", source: first })).toThrow(/provenance/);
    git(root, "checkout", "master");
    git(root, "merge", "--no-ff", "develop", "-m", "Merge develop into master");
    const merge = git(root, "rev-parse", "HEAD");
    const stable = prepareRelease(root, merge, "stable");
    expect(stable.tag).toBe("v1.0.8");
    assertVersions(root, "1.0.8");
    expect(git(root, "rev-parse", "master")).toBe(merge);
    expect(git(root, "rev-parse", "v1.0.8^")).toBe(merge);
    git(root, "update-ref", "refs/remotes/origin/master", merge);
    expect(validateRelease(root, { tag: "v1.0.8", channel: "stable", source: merge }).tag).toBe("v1.0.8");
    git(root, "checkout", "--detach", merge);
    expect(prepareRelease(root, merge, "stable").reuse).toBe(true);
    git(root, "checkout", "develop");
    expect(() => prepareRelease(root, second, "development")).not.toThrow();
    git(root, "checkout", "develop");
    writeVersions(root, "1.0.8");
    writeFileSync(join(root, "release-plan.json"), '{"base":"1.0.8","target":"1.1.0"}\n');
    const next = commit(root, "chore: synchronize stable version and open next cycle");
    expect(prepareRelease(root, next, "development").tag).toBe("v1.1.0-dev.1");
    expect(readTags(root).find((tag) => tag.name === "v1.0.8").source).toBe(merge);
    expect(git(root, "rev-parse", "develop")).toBe(next);
  }, 30000);

  it("refuses promotion without a development tag or without the latest development source", () => {
    const root = fixture();
    const initial = git(root, "rev-parse", "HEAD");
    expect(() => prepareRelease(root, initial, "stable")).toThrow(/latest development/);
    git(root, "checkout", "-b", "develop");
    writeFileSync(join(root, "app.txt"), "not merged");
    const dev = commit(root, "feat: something");
    prepareRelease(root, dev, "development");
    git(root, "checkout", "master");
    expect(() => prepareRelease(root, initial, "stable")).toThrow(/latest development/);
  });

  it.each([
    ["development", "windows-x86_64", "x64-setup.exe"],
    ["stable", "windows-x86_64", "x64_en-US.msi"],
    ["development", "linux-x86_64", "amd64.AppImage"],
    ["stable", "linux-x86_64", "amd64.AppImage"],
  ])("collects actual %s %s file layouts and requires signatures", (channel, platform, suffix) => {
    const root = fixture();
    const version = channel === "development" ? "1.0.8-dev.1" : "1.0.8";
    writeVersions(root, version);
    const bundle = join(root, "src-tauri", "target", "release", "bundle", "installer");
    mkdirSync(bundle, { recursive: true });
    const name = `simple-media-overlay_${version}_${suffix}`;
    writeFileSync(join(bundle, name), "installer");
    const env = { RELEASE_TAG: `v${version}`, RELEASE_CHANNEL: channel, RELEASE_PLATFORM: platform, GITHUB_REPOSITORY: "example/overlay" };
    expect(() => collectRelease(root, env)).toThrow();
    writeFileSync(join(bundle, `${name}.sig`), "signature\n");
    expect(collectRelease(root, env)).toEqual(expect.objectContaining({
      version, name, platform, signature: "signature",
    }));
    expect(readFileSync(join(root, "release-assets", name), "utf8")).toBe("installer");
  });
});
