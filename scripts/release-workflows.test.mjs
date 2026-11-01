import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");

describe("release workflow contracts", () => {
  it("uses queued, noncancelling releases and does not ignore the rollout", () => {
    const auto = workflow("auto-version");
    const release = workflow("release");
    for (const text of [auto, release]) {
      expect(text).toContain("cancel-in-progress: false");
      expect(text).toContain("queue: max");
      expect(text).not.toContain("GH_PAT");
    }
    expect(auto).not.toContain("paths-ignore:");
    expect(auto).toContain("uses: ./.github/workflows/release.yml");
    expect(auto).toContain('git push origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"');
    expect(auto).not.toContain("--tags");
    expect(auto).toContain("needs: [qualify, tests]");
  });

  it("retains the explicit dispatch consumer and builds from verified tags, never arbitrary pushes", () => {
    const release = workflow("release");
    expect(release).toContain("types: [release-requested]");
    for (const field of ["tag", "channel", "source"]) {
      expect(release).toContain(`github.event.client_payload.${field}`);
    }
    expect(release).not.toMatch(/^  push:/m);
    expect(release).toContain("ref: ${{ needs.validate.outputs.tag }}");
    expect(release).toContain("needs: [validate, tests]");
    expect(release).toContain("needs: [validate, create-release, build-tauri]");
    expect(release).toContain("fail-fast: false");
    expect(release).toContain("--bundles nsis -- --locked");
    expect(release).toContain("--bundles msi -- --locked");
    expect(release).toContain("--bundles appimage -- --locked");
  });

  it("uses supported action versions independently of project Node.js", () => {
    for (const name of ["auto-version", "release", "test"]) {
      const text = workflow(name);
      expect(text).not.toMatch(/actions\/(?:checkout|setup-node|github-script)@v[47](?:\s|$)/m);
      expect(text).not.toContain("node-version: 20");
      expect(text).toContain("node-version: 24");
    }
    expect(workflow("release")).toContain("actions/upload-artifact@v7.0.2");
    expect(workflow("release")).toContain("actions/download-artifact@v8.0.2");
  });
});
