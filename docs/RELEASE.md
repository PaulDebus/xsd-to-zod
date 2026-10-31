# Release checklist

Use this for every npm release. The release process lives in git, so it is
available without an external tracker. This file is not published in the npm
tarball; `package.json` lists the shipped docs explicitly.

## Preconditions

- The release PR is merged and the worktree is clean.
- `npm ci` has run and `npm whoami` shows the expected npm account.
- `gh auth status` shows a token that can create tags and GitHub releases.
- `CHANGELOG.md` has an entry for the version being released.

## 1. Prepare the version branch

```sh
git fetch origin main
git switch -c release/<version> origin/main
npm run version:set -- <version>
```

`version:set` updates `package.json`, `package-lock.json`, and
`src/version.ts` together. Then:

- Set the `CHANGELOG.md` heading to `<version> — YYYY-MM-DD`.
- Remove stale version references, especially "next release" wording and the
  previous version in README/docs examples:

```sh
git grep -n -E '<previous-version>|next release' -- README.md CHANGELOG.md docs src
git grep -n -E 'PACKAGE_VERSION|"version"' -- package.json package-lock.json src/version.ts
```

## 2. Run the release gate

```sh
npm run test:release
npm pack --dry-run --json
```

`test:release` runs lint, the full coverage suite, and the full W3C corpus.
Never release from `test:quick` alone.

Inspect the pack output: it should contain `dist`, `README.md`, `CHANGELOG.md`,
`LICENSE`, and only the docs listed in `package.json` `files`. It must not
contain `coverage/`, `testdata/`, `tests/`, or this checklist.

## 3. Merge the release PR

Commit, push, and open a PR from the release branch. Merge only after CI is
green, then update local `main`:

```sh
git fetch origin main
git switch main
git pull --ff-only
```

## 4. Tag and publish

Tag the merged `main` commit, not the release branch:

```sh
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

Publish:

```sh
npm publish
npm view xsd-to-zod@<version> version
```

`prepublishOnly` re-runs `npm run test:release` and the build. Budget for that
second gate; do not use `npm publish --dry-run` as a packaging check because it
runs the same gate. Use `npm pack --dry-run --json` for the fast check.

## 5. Close out on GitHub

```sh
gh release create v<version> --title "v<version>" --generate-notes
gh issue close <number> --comment "Released in v<version>"
```

Edit the generated release notes if needed, then verify the tag, GitHub
release, and npm version all point at the merged `main` commit.
