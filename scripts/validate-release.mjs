import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertVersions, releaseTag } from "./release-version.mjs";
import { ancestor, git, readTags } from "./prepare-release.mjs";

export function validateRelease(root, { tag, channel, source }) {
  const version = releaseTag(tag, channel).version;
  const managed = readTags(root).find((entry) => entry.name === tag);
  if (managed?.source !== source || managed?.channel !== channel) {
    throw new Error("Release request does not match managed tag provenance");
  }
  if (git(root, "rev-parse", "HEAD") !== git(root, "rev-parse", `${tag}^{commit}`)
    || git(root, "rev-parse", "HEAD^") !== source) {
    throw new Error("Release tag must point to a version commit directly following the tested source");
  }
  const branch = channel === "development" ? "develop" : "master";
  if (!ancestor(root, source, `origin/${branch}`)) {
    throw new Error(`Release source is not on ${branch}`);
  }
  const plan = JSON.parse(readFileSync(resolve(root, "release-plan.json"), "utf8"));
  if (plan.base !== managed.base || plan.target !== managed.target) {
    throw new Error("Tagged release plan and provenance differ");
  }
  assertVersions(root, version);
  return { tag, channel, source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { RELEASE_TAG: tag, RELEASE_CHANNEL: channel, RELEASE_SOURCE: source } = process.env;
  const result = validateRelease(process.cwd(), { tag, channel, source });
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
