import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { sha256 } from "./collect-release.mjs";
import { releaseTag } from "./release-version.mjs";

function request(env) {
  const { RELEASE_TAG: tag, RELEASE_CHANNEL: channel, RELEASE_SOURCE: source } = env;
  releaseTag(tag, channel);
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Invalid release source");
  return { tag, channel, source };
}

function marker(info) {
  return `<!-- smo-release:${JSON.stringify(info)} -->`;
}

export function assertRelease(release, info) {
  if (release.tag_name !== info.tag || release.prerelease !== (info.channel === "development")
    || !release.body?.includes(marker(info))) {
    throw new Error("Existing release is not owned by this release request; refusing to modify it");
  }
  if (!release.draft) {
    const names = release.assets.filter((asset) => asset.size > 0).map((asset) => asset.name);
    const windows = info.channel === "development" ? "-setup.exe" : ".msi";
    if (!names.includes("latest.json") || !names.includes("release-manifest.json")
      || !names.some((name) => name.endsWith(windows) && names.includes(`${name}.sig`))
      || !names.some((name) => name.endsWith(".AppImage") && names.includes(`${name}.sig`))) {
      throw new Error("Published release is incomplete; investigate manually without overwriting published assets");
    }
  }
}

export async function beginRelease(github, repo, env) {
  const info = request(env);
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  const existing = releases.find((release) => release.tag_name === info.tag);
  if (existing) {
    assertRelease(existing, info);
    return { id: existing.id, complete: !existing.draft };
  }
  const previous = releases.filter((release) => !release.draft && !release.prerelease
    && semver.valid(release.tag_name.slice(1))
    && semver.lt(release.tag_name.slice(1), info.tag.slice(1)))
    .sort((a, b) => semver.rcompare(a.tag_name.slice(1), b.tag_name.slice(1)))[0];
  const { data: notes } = await github.rest.repos.generateReleaseNotes({
    ...repo, tag_name: info.tag,
    ...(previous ? { previous_tag_name: previous.tag_name } : {}),
  });
  const body = `${marker(info)}\n\n${info.channel === "development"
    ? "Development prerelease: install manually. The automatic updater follows stable releases.\n\n"
    : ""}${notes.body}`;
  const { data } = await github.rest.repos.createRelease({
    ...repo, tag_name: info.tag, name: info.tag, body,
    draft: true, prerelease: info.channel === "development", make_latest: "false",
  });
  return { id: data.id, complete: false };
}

export function releaseAssets(directory, info, repository, date) {
  const version = releaseTag(info.tag, info.channel).version;
  const platforms = {};
  const assets = [];
  for (const platform of ["windows-x86_64", "linux-x86_64"]) {
    const metadata = JSON.parse(readFileSync(join(directory, `${platform}.json`), "utf8"));
    if (metadata.platform !== platform || metadata.tag !== info.tag || metadata.version !== version
      || !metadata.signature || !/^[^/\\]+$/.test(metadata.name)) {
      throw new Error(`Invalid ${platform} artifact metadata`);
    }
    const expectedExtension = platform === "linux-x86_64" ? ".AppImage"
      : info.channel === "development" ? "-setup.exe" : ".msi";
    if (!metadata.name.endsWith(expectedExtension) || !metadata.name.includes(`_${version}_`)) {
      throw new Error(`Unexpected ${platform} installer name`);
    }
    const url = `https://github.com/${repository}/releases/download/${info.tag}/${metadata.name}`;
    if (metadata.url !== url) throw new Error("Artifact URL does not match the release");
    for (const [name, hash] of [[metadata.name, metadata.sha256], [`${metadata.name}.sig`, metadata.signatureSha256]]) {
      const data = readFileSync(join(directory, name));
      if (!data.length || sha256(data) !== hash) throw new Error(`Artifact integrity mismatch for ${name}`);
      if (name.endsWith(".sig") && data.toString("utf8").trim() !== metadata.signature) {
        throw new Error(`Signature metadata mismatch for ${name}`);
      }
      assets.push({ name, data });
    }
    platforms[platform] = { signature: metadata.signature, url };
  }
  const latest = { version, notes: "See release notes for details", pub_date: date, platforms };
  assets.push({ name: "latest.json", data: Buffer.from(`${JSON.stringify(latest, null, 2)}\n`) });
  const manifest = { ...info, assets: assets.map(({ name, data }) => ({ name, sha256: sha256(data), size: data.length })) };
  assets.push({ name: "release-manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  return assets;
}

export async function publishRelease(github, repo, env, directory = "release-assets") {
  const info = request(env);
  const releaseId = Number(env.RELEASE_ID);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error("Invalid release ID");
  const { data: release } = await github.rest.repos.getRelease({ ...repo, release_id: releaseId });
  assertRelease(release, info);
  if (!release.draft) return;
  const assets = releaseAssets(directory, info, `${repo.owner}/${repo.repo}`, release.created_at);
  // Only this owned draft may be repaired. Published assets are never clobbered.
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: releaseId, per_page: 100 });
  const unexpected = existing.filter((asset) => !assets.some((expected) => expected.name === asset.name));
  if (unexpected.length) throw new Error(`Draft has unexpected assets: ${unexpected.map((asset) => asset.name).join(", ")}`);
  for (const asset of assets) {
    const old = existing.find((entry) => entry.name === asset.name);
    if (old) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: old.id });
    await github.rest.repos.uploadReleaseAsset({
      ...repo, release_id: releaseId, name: asset.name, data: asset.data,
      headers: { "content-type": "application/octet-stream", "content-length": asset.data.length },
    });
  }
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: releaseId, per_page: 100 });
  if (uploaded.length !== assets.length || assets.some((asset) =>
    !uploaded.some((entry) => entry.name === asset.name && entry.size === asset.data.length))) {
    throw new Error("Release asset upload verification failed; leaving draft unpublished");
  }
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  const newerStable = releases.some((entry) => !entry.draft && !entry.prerelease
    && semver.valid(entry.tag_name.slice(1)) && semver.gt(entry.tag_name.slice(1), info.tag.slice(1)));
  await github.rest.repos.updateRelease({
    ...repo, release_id: releaseId, draft: false,
    prerelease: info.channel === "development",
    make_latest: info.channel === "stable" && !newerStable ? "true" : "false",
  });
  const { data: published } = await github.rest.repos.getRelease({ ...repo, release_id: releaseId });
  assertRelease(published, info);
  if (published.draft) throw new Error("Release remained a draft after publication");
}
