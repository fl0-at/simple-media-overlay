import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginRelease, publishRelease, releaseAssets } from "./publish-release.mjs";
import { sha256 } from "./collect-release.mjs";

const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repo = { owner: "example", repo: "overlay" };
const source = "a".repeat(40);
const env = (channel = "development") => ({
  RELEASE_TAG: channel === "development" ? "v1.0.8-dev.3" : "v1.0.8",
  RELEASE_CHANNEL: channel,
  RELEASE_SOURCE: source,
  RELEASE_ID: "42",
});
const info = (channel = "development") => ({ tag: env(channel).RELEASE_TAG, channel, source });

function draft(channel = "development") {
  return {
    id: 42, tag_name: info(channel).tag, prerelease: channel === "development", draft: true,
    created_at: "2026-11-01T00:00:00Z", assets: [],
    body: `<!-- smo-release:${JSON.stringify(info(channel))} -->`,
  };
}

function artifacts(channel = "development") {
  const root = mkdtempSync(join(tmpdir(), "smo-assets-test-"));
  temporary.push(root);
  mkdirSync(join(root, "release-assets"));
  const version = info(channel).tag.slice(1);
  for (const platform of ["windows-x86_64", "linux-x86_64"]) {
    const suffix = platform === "linux-x86_64" ? "amd64.AppImage"
      : channel === "development" ? "x64-setup.exe" : "x64_en-US.msi";
    const name = `simple-media-overlay_${version}_${suffix}`;
    const data = Buffer.from(`signed installer ${platform}`);
    const signature = Buffer.from(`signature ${platform}\n`);
    const directory = join(root, "release-assets");
    writeFileSync(join(directory, name), data);
    writeFileSync(join(directory, `${name}.sig`), signature);
    writeFileSync(join(directory, `${platform}.json`), JSON.stringify({
      ...info(channel), version, platform, name, signature: signature.toString().trim(),
      url: `https://github.com/example/overlay/releases/download/${info(channel).tag}/${name}`,
      sha256: sha256(data), signatureSha256: sha256(signature),
    }));
  }
  return root;
}

function mockGithub(release = draft(), otherReleases = []) {
  const rest = { repos: {
    listReleases: vi.fn(), listReleaseAssets: vi.fn(),
    generateReleaseNotes: vi.fn().mockResolvedValue({ data: { body: "Release notes" } }),
    createRelease: vi.fn().mockResolvedValue({ data: { id: 42 } }),
    getRelease: vi.fn(async () => ({ data: release })),
    deleteReleaseAsset: vi.fn(async ({ asset_id }) => {
      release.assets = release.assets.filter((asset) => asset.id !== asset_id);
    }),
    uploadReleaseAsset: vi.fn(async ({ name, data }) => {
      release.assets.push({ id: release.assets.length + 100, name, size: data.length });
    }),
    updateRelease: vi.fn(async ({ draft, prerelease }) => {
      release.draft = draft;
      release.prerelease = prerelease;
    }),
  } };
  const paginate = vi.fn(async (method) => method === rest.repos.listReleaseAssets
    ? [...release.assets] : [release, ...otherReleases]);
  return { rest, paginate };
}

describe("release publication and recovery", () => {
  it("creates a prerelease draft without replacing latest and uses published stable history for notes", async () => {
    const github = mockGithub();
    github.paginate.mockResolvedValue([{ tag_name: "v1.0.5", prerelease: false, draft: false }]);
    expect(await beginRelease(github, repo, env())).toEqual({ id: 42, complete: false });
    expect(github.rest.repos.createRelease).toHaveBeenCalledWith(expect.objectContaining({
      tag_name: "v1.0.8-dev.3", draft: true, prerelease: true, make_latest: "false",
    }));
    expect(github.rest.repos.generateReleaseNotes).toHaveBeenCalledWith(expect.objectContaining({ previous_tag_name: "v1.0.5" }));
  });

  it("resumes an owned draft but refuses an unrelated existing release", async () => {
    const github = mockGithub();
    expect(await beginRelease(github, repo, env())).toEqual({ id: 42, complete: false });
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    github.paginate.mockResolvedValue([{ ...draft(), body: "Someone else's release" }]);
    await expect(beginRelease(github, repo, env())).rejects.toThrow(/refusing/);
  });

  it.each(["development", "stable"])("requires both platforms and produces a complete %s updater manifest", (channel) => {
    const directory = join(artifacts(channel), "release-assets");
    const assets = releaseAssets(directory, info(channel), "example/overlay", "2026-11-01T00:00:00Z");
    expect(assets.map((asset) => asset.name)).toHaveLength(6);
    const latest = JSON.parse(assets.find((asset) => asset.name === "latest.json").data);
    expect(latest.version).toBe(info(channel).tag.slice(1));
    expect(Object.keys(latest.platforms).sort()).toEqual(["linux-x86_64", "windows-x86_64"]);
    rmSync(join(directory, "linux-x86_64.json"));
    expect(() => releaseAssets(directory, info(channel), "example/overlay", "")).toThrow();
  });

  it("rejects modified installers instead of publishing success-shaped metadata", () => {
    const directory = join(artifacts(), "release-assets");
    const metadata = JSON.parse(readFileSync(join(directory, "windows-x86_64.json"), "utf8"));
    writeFileSync(join(directory, metadata.name), "corrupted");
    expect(() => releaseAssets(directory, info(), "example/overlay", "")).toThrow(/integrity/);
  });

  it.each(["development", "stable"])("publishes %s only after all assets, then makes reruns no-ops", async (channel) => {
    const root = artifacts(channel);
    const release = draft(channel);
    const github = mockGithub(release);
    const directory = join(root, "release-assets");
    await publishRelease(github, repo, env(channel), directory);
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith(expect.objectContaining({
      draft: false, prerelease: channel === "development",
      make_latest: channel === "stable" ? "true" : "false",
    }));
    expect(release.assets.some((asset) => asset.name === "release-manifest.json")).toBe(true);
    const uploads = github.rest.repos.uploadReleaseAsset.mock.calls.length;
    await publishRelease(github, repo, env(channel), directory);
    expect(github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(uploads);
    expect(await beginRelease(github, repo, env(channel))).toEqual({ id: 42, complete: true });
  });

  it("leaves partial uploads as a draft and repairs them on rerun", async () => {
    const root = artifacts();
    const release = draft();
    const github = mockGithub(release);
    github.rest.repos.uploadReleaseAsset.mockRejectedValueOnce(new Error("Upload failed"));
    const directory = join(root, "release-assets");
    await expect(publishRelease(github, repo, env(), directory)).rejects.toThrow(/Upload failed/);
    expect(release.draft).toBe(true);
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
    release.assets.push({ id: 3, name: "latest.json", size: 1 });
    await publishRelease(github, repo, env(), directory);
    expect(github.rest.repos.deleteReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 3 }));
    expect(release.draft).toBe(false);
  });

  it("does not replace a newer stable release when recovering an older one", async () => {
    const root = artifacts("stable");
    const github = mockGithub(draft("stable"), [{ tag_name: "v1.1.0", draft: false, prerelease: false }]);
    await publishRelease(github, repo, env("stable"), join(root, "release-assets"));
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith(expect.objectContaining({ make_latest: "false" }));
  });

  it("refuses to repair incomplete published releases", async () => {
    const github = mockGithub({ ...draft(), draft: false });
    await expect(beginRelease(github, repo, env())).rejects.toThrow(/incomplete/);
    expect(github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
  });
});
