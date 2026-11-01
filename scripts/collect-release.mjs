import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertVersions, releaseTag } from "./release-version.mjs";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export function collectRelease(root, env) {
  const { RELEASE_TAG: tag, RELEASE_CHANNEL: channel, RELEASE_PLATFORM: platform, GITHUB_REPOSITORY: repo } = env;
  const version = releaseTag(tag, channel).version;
  assertVersions(root, version);
  if (!["windows-x86_64", "linux-x86_64"].includes(platform)) throw new Error(`Unsupported platform ${platform}`);
  const extension = platform === "linux-x86_64" ? ".AppImage" : channel === "development" ? "-setup.exe" : ".msi";
  const installers = files(join(root, "src-tauri", "target", "release", "bundle"))
    .filter((path) => path.endsWith(extension));
  if (installers.length !== 1) throw new Error(`Expected one ${extension} installer, got ${installers.length}`);
  const installer = installers[0];
  const name = basename(installer);
  if (!name.includes(`_${version}_`)) throw new Error(`Installer ${name} does not match embedded version ${version}`);
  const signature = readFileSync(`${installer}.sig`, "utf8").trim();
  if (!signature) throw new Error(`Empty signature for ${name}`);
  const destination = join(root, "release-assets");
  mkdirSync(destination, { recursive: true });
  copyFileSync(installer, join(destination, name));
  copyFileSync(`${installer}.sig`, join(destination, `${name}.sig`));
  const metadata = {
    tag, version, platform, name, signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    sha256: sha256(readFileSync(installer)),
    signatureSha256: sha256(readFileSync(`${installer}.sig`)),
  };
  writeFileSync(join(destination, `${platform}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  collectRelease(process.cwd(), process.env);
}
