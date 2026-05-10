#!/usr/bin/env bash
# End-to-end local release: bump versions, build, commit, tag, push, and
# create a draft GitHub Release with main.js / manifest.json / styles.css
# attached. The .github/workflows/release.yml workflow does the same thing
# in CI; this script lets you ship a release without using any Actions
# minutes — useful when over quota, when working offline, or when you just
# prefer not to wait for CI.
#
# Usage:  ./scripts/release.sh <version>          (e.g. 1.0.1)
# Skip the local build step if you already have a fresh main.js:
#         RELEASE_SKIP_BUILD=1 ./scripts/release.sh 1.0.1
# Skip the local "gh release create" step (CI / workflow will do it):
#         RELEASE_SKIP_GH=1 ./scripts/release.sh 1.0.1

set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 1.0.1"
  exit 1
fi

# Validate semver — Obsidian's plugin spec requires plain x.y.z (no v-prefix,
# no pre-release suffix in the tag name).
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in x.y.z format (got '$VERSION')"
  exit 1
fi

# Refuse to operate on a dirty tree — any in-flight edits would silently
# end up in the version-bump commit and confuse `git blame`.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes — commit or stash first"
  exit 1
fi

# Sanity-check that gh is authenticated (only matters if we'll create the
# release locally; gate the check on the same flag).
if [ -z "${RELEASE_SKIP_GH:-}" ]; then
  if ! gh auth status >/dev/null 2>&1; then
    echo "Error: 'gh' is not authenticated. Run 'gh auth login' or set"
    echo "RELEASE_SKIP_GH=1 to skip the local release-create step."
    exit 1
  fi
fi

echo "▶ Releasing $VERSION..."

# 1. Bump manifest.json
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  m.version = '$VERSION';
  fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# 2. Bump package.json (--no-git-tag-version so we control the tag below)
npm version "$VERSION" --no-git-tag-version --no-workspaces-update > /dev/null

# 3. Append to versions.json with the current minAppVersion
node -e "
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
  versions[manifest.version] = manifest.minAppVersion;
  fs.writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
"

# 4. Build main.js — produces the artifact we'll attach to the release.
#    Skip when RELEASE_SKIP_BUILD=1 is set (assumes a fresh main.js exists).
if [ -z "${RELEASE_SKIP_BUILD:-}" ]; then
  echo "▶ Building..."
  npm run build
fi

# main.js, manifest.json, and styles.css must all be present at this point —
# bail loudly if not, since the release would otherwise be incomplete.
for asset in main.js manifest.json styles.css; do
  if [ ! -f "$asset" ]; then
    echo "Error: required asset '$asset' is missing — cannot create release."
    exit 1
  fi
done

# 5. Commit the version bump
git add manifest.json package.json package-lock.json versions.json
git commit -m "chore: release $VERSION"

# 6. Tag the release commit
git tag -a "$VERSION" -m "$VERSION"

# 7. Push commit + tag
git push origin main
git push origin "$VERSION"

# 8. Create the GitHub Release locally (draft, with the three Obsidian assets)
if [ -z "${RELEASE_SKIP_GH:-}" ]; then
  echo "▶ Creating draft GitHub Release..."
  gh release create "$VERSION" \
    --title="$VERSION" \
    --draft \
    main.js manifest.json styles.css

  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
  if [ -n "$REPO" ]; then
    echo "✓ Done. Edit + publish the draft at:"
    echo "   https://github.com/$REPO/releases"
  else
    echo "✓ Done. Edit + publish the draft from the GitHub Releases page."
  fi
else
  echo "✓ Tag pushed. Skipping local release-create (RELEASE_SKIP_GH=1) —"
  echo "  the .github/workflows/release.yml workflow will create the draft."
fi
