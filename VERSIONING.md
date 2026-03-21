# Version Bumping & Release Guide

This project uses automated version bumping and releases via GitHub Actions.

## How It Works

### Automatic Version Bumping

When you push to the `master` or `develop` branch, the version is automatically bumped based on your commit message:

- `master` creates stable releases (for production users)
- `develop` creates experimental prereleases

#### Version Bump Types

- **Patch** (0.3.1 → 0.3.2): Default for all commits

  ```bash
  git commit -m "fix: resolve issue with media controls"
  ```

- **Minor** (0.3.1 → 0.4.0): Use `[minor]` or `feat:` prefix

  ```bash
  git commit -m "[minor] add new overlay theme support"
  # or
  git commit -m "feat: add playlist navigation"
  ```

- **Major** (0.3.1 → 1.0.0): Use `[major]` or `BREAKING CHANGE`

  ```bash
  git commit -m "[major] redesign entire UI"
  # or
  git commit -m "BREAKING CHANGE: new API structure"
  ```

### Release Notes Generation

Release notes are automatically generated from your commit messages and categorized:

- ✨ **New Features**: Commits starting with `feat:` or `feature:`
- 🔧 **Improvements**: Commits starting with `improve:` or `enhancement:`
- 🐛 **Bug Fixes**: Commits starting with `fix:` or `bugfix:`
- ⚡ **Performance**: Commits starting with `perf:` or `performance:`
- 📝 **Other Changes**: Everything else (excluding chore, docs, etc.)

#### Examples

Good commit messages for nice release notes:

```bash
git commit -m "feat: add keyboard shortcuts for media controls"
git commit -m "fix: album art not displaying correctly on 4K displays"
git commit -m "improve: faster startup time"
git commit -m "perf: optimize media timeline rendering"
```

## Complete Workflow

1. **Make changes** and commit with descriptive messages

   ```bash
   git add .
   git commit -m "feat: add support for volume control"
   ```

2. **Push to your release branch**

   ```bash
   # stable release flow
   git push origin master

   # experimental prerelease flow
   git push origin develop
   ```

3. **Automated process**:
   - Auto-version workflow detects commit type
   - Bumps version in `package.json`, `tauri.conf.json`, and `Cargo.toml`
   - Creates a git tag:
     - stable: `v0.4.0`
     - develop prerelease: `v0.4.0-1`
   - Pushes the tag

4. **Release build**:
   - Tag triggers release workflow
   - Generates release notes from commits
   - Builds and signs the app
   - Creates GitHub release with installers
   - Tags with `-N` (numeric prerelease) are marked as GitHub **Prerelease** automatically
   - Publishes update manifest for auto-updates

5. **Users get updates**:
   - Next time users launch the app, they'll be notified
   - Update downloads automatically
   - Installs on next app restart

## Manual Version Override

If you need to set a specific version manually:

1. Update all three files:
   - `package.json` → `"version": "1.0.0"`
   - `src-tauri/tauri.conf.json` → `"version": "1.0.0"`
   - `src-tauri/Cargo.toml` → `version = "1.0.0"`

2. Commit with `[skip ci]` to prevent auto-bump:

   ```bash
   git commit -m "chore: set version to 1.0.0 [skip ci]"
   ```

3. Manually create and push tag:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

## Tips

- Use conventional commits for better release notes
- The workflow ignores commits starting with `chore:`, `docs:`, `style:`, `refactor:`, `test:`, `build:`, `ci:`
- Changes to `.github/**`, `README.md`, and `.gitignore` don't trigger version bumps
- All version bumps are committed with `[skip ci]` to prevent infinite loops
