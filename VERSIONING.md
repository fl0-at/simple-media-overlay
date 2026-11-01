# Release lifecycle

## Policy: reviewed target, independent development counter

[release-plan.json](release-plan.json) defines the stable baseline and intended
stable target. Both must be canonical stable SemVer versions; the target must
exceed the baseline. Reviewers choose the target based on **all changes planned
for the release**, not the final merge commit:

| Release significance | Example from 1.0.8 |
| --- | --- |
| Compatible fixes | 1.0.9 |
| Compatible features | 1.1.0 |
| Breaking changes | 2.0.0 |

Commit prefixes do not select versions or suppress releases. The old script
treated `feat:` and `fix:` differently on the two branches; that behavior is
removed rather than assumed reliable. There is **no special squash or merge
message convention**. Commit messages still appear in GitHub-generated notes,
which use the previous published stable release as their baseline.

Keep the target fixed throughout a development cycle. For target `1.0.8`,
qualifying tested `develop` pushes create `v1.0.8-dev.1`, `v1.0.8-dev.2`, etc.
The counter is selected using SemVer-aware tag inspection, including tags whose
build or publication failed. Merging the latest development source into `master`
with a regular merge commit creates `v1.0.8`, **not** `v1.0.9`.

The baseline must match the highest existing stable SemVer tag, whether or not
it has a published release. Existing versions are reserved forever. Changing a
target mid-cycle is not the normal process: if the release scope changes, stop
and review a revised plan explicitly; abandoned development tags remain reserved.

## Eligibility and tests

- Feature/bugfix branches are squash-merged into `develop`.
- `develop` is merged into `master` with a regular merge commit, preserving the
  ancestry of the latest development prerelease source.
- A push is qualifying when its before/after diff contains a file other than
  Markdown documentation, `docs/**`, or `.gitignore`. CI, dependency, Rust,
  refactoring, test and build changes qualify regardless of commit prefix.
- `.github/**` is **not ignored**. A workflow-only rollout must execute the new
  pipeline. Documentation-only pushes run normal Tests but do not release.
- For an intentional documentation-only release or recovery before a tag exists,
  manually run **Auto Version Bump** on `develop` or `master`. It still runs tests.
- Do not put `[skip ci]` or another GitHub skip annotation on a rollout/release
  merge: GitHub itself skips push workflows before our eligibility check runs.
  No skip annotation is required for documentation changes.
- All automated version/tag preparation waits for lint, Vitest, and the frontend
  build. The release workflow validates and tests the tagged version commit again
  before creating a draft or building signed native artifacts.

The required check remains `Tests / Lint, test, and build`. Require it on both
branches if merging with failed tests must be prohibited; the publicly visible
rulesets inspected during migration require one PR approval but do not list
required status checks. Configure this manually if desired, not via this change.

## Version commits without protected-branch pushes

The approved strategy is **tag-only version commits**. After tests succeed, the
workflow checks out the exact source SHA detached, updates all version-bearing
files, and creates an annotated tag on a new child commit:

```text
develop source D ---- version commit (1.0.8-dev.3), tagged v1.0.8-dev.3
       \
        regular master merge M ---- version commit (1.0.8), tagged v1.0.8
```

Only that single tag is pushed. Neither `develop` nor `master` advances to the
bot's commit. Branch files intentionally represent the stable baseline, while
each tagged source tree has its actual artifact version in:

- [package.json](package.json)
- [package-lock.json](package-lock.json), including its root package entry
- [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)
- the `[package]` section of [src-tauri/Cargo.toml](src-tauri/Cargo.toml)
- the local application entry of [src-tauri/Cargo.lock](src-tauri/Cargo.lock)

Other Rust package/dependency versions are preserved. TOML is parsed structurally
and versions are checked with the `semver` package. Native builds use `--locked`.
The stable version commit is created from the tested master merge, with the
stable version embedded **before** compilation. Prerelease binaries are never
relabelled.

This avoids the existing reviewed-PR rules on both branches without weakening
them, adding a bot bypass, or making an unexpected direct push/back-merge.

### Synchronizing after stable publication and opening the next cycle

After `v1.0.8` is successfully published:

1. A maintainer prepares a normal reviewed PR to `develop`, synchronizing the
   five version-bearing files to `1.0.8`. Use the version-only stable tag commit
   as the reference; do not copy older dependency manifests over newer work.
   The existing helper can update only the version fields:

   ```bash
   node --input-type=module -e "import { writeVersions } from './scripts/release-version.mjs'; writeVersions(process.cwd(), '1.0.8');"
   ```

2. **In the same PR**, change the plan to the next reviewed target, for example:

   ```json
   { "base": "1.0.8", "target": "1.0.9" }
   ```

3. Its squash merge starts `1.0.9-dev.1` after tests. The baseline synchronization
   and plan change are required before any new development source is released;
   a closed/stale cycle fails explicitly instead of inventing a new version.
4. The next regular `develop` -> `master` merge carries the synchronized baseline
   and plan, then creates the next stable tag-only version commit.

No back-merge is automated. Under the approved tag-only strategy, `master`'s
branch files also retain the prior baseline until the next develop -> master
merge. The stable release tag, not the branch HEAD, is the authoritative stable
version tree. Do not merge a separate version-only PR into master: it would
attempt the closed-cycle release gate.

## Channels, artifacts, and authentication

[Auto Version Bump](.github/workflows/auto-version.yml) calls the reusable
[Release](.github/workflows/release.yml) workflow with explicit `tag`, `channel`
(`development` or `stable`), and `source` (the original tested commit SHA).
The annotated tag records these plus the baseline and target. The consumer
rejects mismatched channel, provenance, branch ancestry, or embedded versions.

The reusable call is intentional: on the **first develop rollout**, the default
branch still has the old `repository_dispatch` consumer. Calling the workflow
from the triggering commit uses the new develop implementation immediately.

Once the changes reach default-branch `master`, `release-requested`
`repository_dispatch` remains available for external/manual recovery. Its
`client_payload` must contain all three fields, for example:

```json
{
  "event_type": "release-requested",
  "client_payload": {
    "tag": "v1.0.8-dev.3",
    "channel": "development",
    "source": "<full SHA recorded in the annotated tag>"
  }
}
```

Tag-only legacy requests now fail explicitly. Arbitrary tag pushes no longer
trigger Release; manually running Release requires an existing managed tag and
the same explicit inputs. Before the master rollout, use the Auto Version Bump
run on develop for recovery, **not** the old default-branch dispatch consumer.

### Required repository permissions and secrets before merging

- Enable GitHub Actions and allow the actions listed below.
- `GITHUB_TOKEN` needs `contents: write` for the tag-preparation and draft/
  publication jobs. Other jobs have read-only contents access.
- Check that tag rulesets permit creation of `v*` tags by Actions. No branch
  bypass permission is needed. Public inspection found two active branch
  rulesets (PR approval, deletion and non-fast-forward restrictions); authenticated
  classic protection details and private bypass lists were not accessible.
- Set `TAURI_SIGNING_PRIVATE_KEY`; set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if
  the key is encrypted. The key must correspond to the existing updater public
  key in the Tauri configuration. Missing keys/signatures fail the build.
- **`GH_PAT` is no longer used or required.** Do not add a personal token merely
  to trigger tag workflows. The reusable call does not need a new push event.
  GitHub also permits `repository_dispatch`/`workflow_dispatch` triggers using
  `GITHUB_TOKEN`, unlike ordinary bot push events. An external dispatcher needs
  its own narrowly scoped repository credential with contents-write permission.
- All pushes made by this pipeline are tag-only, using `GITHUB_TOKEN`, whose
  push events do not recursively trigger workflows. Bot version commits also
  contain `[skip ci]`; ordinary `chore:` PRs are not automatically ignored.

### Platform and updater behavior

| Channel | Windows x86_64 | Linux x86_64 | GitHub classification |
| --- | --- | --- | --- |
| development | NSIS `-setup.exe` and signature | AppImage and signature | prerelease, `make_latest: false` |
| stable | MSI and signature | AppImage and signature | non-prerelease, latest unless a newer stable exists |

The approved development switch to NSIS is necessary because Tauri/WiX rejects
`dev.N` identifiers for MSI. A numeric fourth-component override would not
provide reliable Windows Installer upgrade ordering. Stable MSI distribution
is retained. Do not mix development NSIS and stable MSI installations: uninstall
the development installation before switching installer families.

Both channels receive a per-release `latest.json` with both signed platforms.
The application's existing `/releases/latest/download/latest.json` endpoint
continues to follow **stable only**. Development installers are downloaded
manually; automatic development-channel updates are outside this change.

## Concurrency, reruns, and partial-failure recovery

- Lifecycle runs share a serialized queue across both branches; publishing is
  serialized per channel. `queue: max` retains up to 100 pending runs instead
  of replacing a pending release with a newer push. Queue arrival, not source
  commit time, determines execution order. Do not enqueue a master promotion
  until the desired develop run has completed.
- `cancel-in-progress: false` and matrix `fail-fast: false` avoid cancelling
  running releases/other platform builds. Do not manually cancel a publishing
  job unless you are prepared to resume its owned draft.
- The annotated source/channel identity makes reruns reuse the **same tag** and
  version commit, even after that cycle is closed. Existing unrelated tags are
  never deleted, moved, force-pushed, or overwritten.
- A failed tag push leaves no branch mutation. Rerun the same source workflow.
  A successful tag push followed by a failed workflow uses that tag on rerun.
- Draft creation precedes native builds, but publication occurs only after
  both installer/signature pairs and the combined updater manifest validate.
  SHA-256 metadata detects corrupted or mismatched artifacts.
- Rerun **all jobs** after build failure, artifact expiration (14 days), or
  upload failure. Owned draft assets can be replaced during recovery. Foreign
  drafts and published assets cannot be overwritten by the pipeline.
- A fully published owned release is a no-op on rerun; an incomplete published
  release fails for manual investigation. A recovery publication of an older
  stable version never replaces a newer published stable as latest.
- Use the original failed Auto Version Bump run when possible. Running that
  workflow manually on a newer branch HEAD is a **new source**, not a rerun.
  After master rollout, manually run Release with the existing tag/channel/
  original source to resume publishing without making a new tag.

## Migration and the two rollout merges

Read-only inspection on 2026-11-01 found:

| Item | Observed version/ref |
| --- | --- |
| remote `master` | `8bf11d7`, embedded 1.0.7 |
| remote `develop` | `e843c1a`, embedded 1.0.6 |
| highest stable tag | `v1.0.7`; `v1.0.6` also exists |
| latest published stable release | `v1.0.5` |
| feature-branch application files | 1.0.7 |
| committed Cargo application lock entry | stale 1.0.5; existing local correction is 1.0.7 |

No tags or published releases are modified by migration. The checked-in plan
reserves `1.0.7` as baseline and selects `1.0.8` as target. Before merging, recheck
remote tags; if a new stable tag has appeared, review/update both the baseline
version files and plan. The runtime baseline check prevents collisions.

1. **Squash this feature branch into develop.** Include the existing Cargo.lock
   correction in the PR. The PR diff from develop must bring all baseline
   versions to 1.0.7, including both lockfiles. Workflow changes qualify even
   without application changes. After tests, the first run creates
   `v1.0.8-dev.1` and publishes a prerelease through the reusable workflow.
   No manual initialization, special message, PAT, or branch bypass is required.
2. **Wait for that prerelease to finish**, then merge develop into master with
   a regular merge commit. After tests, it creates `v1.0.8` with stable embedded
   versions, rebuilds MSI/AppImage artifacts, and publishes the stable release.
   The merge message does not affect the version. It does not increment again.
3. Synchronize stable versions and choose the next target in a reviewed develop
   PR as described above. A master merge alone does not automatically open the
   next development cycle.

## GitHub Actions modernization

All three workflows, including both reusable entry points, were audited against
official upstream documentation and release metadata on 2026-11-01:

| Action | Previous | Updated supported release | Internal runtime |
| --- | --- | --- | --- |
| [checkout](https://github.com/actions/checkout) | v4 | v7.0.1 | Node.js 24 |
| [setup-node](https://github.com/actions/setup-node) | v4 | v7.1.0 | Node.js 24 |
| [github-script](https://github.com/actions/github-script) | v7 | v9.0.0 | Node.js 24 |
| [upload-artifact](https://github.com/actions/upload-artifact) | v4 | v7.0.2 | Node.js 24 |
| [download-artifact](https://github.com/actions/download-artifact) | v4 | v8.0.2 | Node.js 24 |
| [rust-cache](https://github.com/Swatinem/rust-cache) | floating v2 | v2.9.3 | Node.js 24 |
| [rust-toolchain](https://github.com/dtolnay/rust-toolchain) | stable | stable (retained) | composite, no internal Node.js |

The former JavaScript action majors use Node.js 20, not the obsolete artifact
v1-v3 service. Modernizing the runtime is separate from selecting the Node.js
version used to build the application. Tests and native builds retain **project
Node.js 24**; the obsolete version-bump-only Node.js 20 setup is replaced with 24
for consistent release tooling, not as an application runtime upgrade.

Node.js 24 actions require Actions Runner **2.327.1+**. Checkout's newer
credential storage needs **2.329.0+** for authenticated Git inside Docker
container actions (not used here). Use current GitHub-hosted runners; self-hosted
runners would need upgrading before adoption. Runners are pinned to
`ubuntu-24.04` and `windows-2022` x64 to avoid moving `*-latest` images. Linux
WebKitGTK 4.1/GTK dependencies and Rust stable are retained; Windows uses its
existing MSVC/WebView2 tooling plus Tauri's NSIS bundler for development.

Breaking changes accounted for:

- Checkout v7 fork-safety defaults do not affect ordinary pull requests or these
  trusted push/reusable flows; credentials are not persisted in read-only jobs.
- Setup-node caching is explicit for Tests and disabled for write/signing jobs.
  No custom registry, removed `always-auth`, or dummy `NODE_AUTH_TOKEN` is used.
- Github-script v9's ESM changes are handled through injected `github` and
  dynamic imports, not `require('@actions/github')`.
- Artifact upload/download use matching modern service generations, per-platform
  names, explicit missing-file errors and rerun overwrite **only for temporary
  Actions artifacts**, not published release assets.

See GitHub's official
[workflow trigger authentication](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[concurrency and queue semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
and [release REST API](https://docs.github.com/en/rest/releases/releases).

## Validation

```bash
npm ci
npm run test:release
npm run lint
npm test
npm run build
```

Release tests exercise patch/minor/major targets, numeric development counters,
stable promotion, a real temporary Git merge/retry/next-cycle lifecycle,
version/lock consistency, reserved tags, rollout path qualification, channel
validation, draft recovery, complete signed metadata, and published-release
no-op/immutability. Tests never push to a remote or call the real release API.

For local workflow syntax checking, actionlint 1.7.12 checks the workflows except
that its schema predates GitHub's documented `concurrency.queue` key. Use the
narrow exclusion `-ignore 'unexpected key "queue" for "concurrency" section'`
with that version; do not remove the release queue to satisfy an older schema.
