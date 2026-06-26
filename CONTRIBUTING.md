# Contributing & branching model

RestWalker follows a Git Flow–style process with CI/CD on a self-hosted runner.

## Branches

| Branch | Purpose | Who pushes |
|---|---|---|
| `master` | Release-only. A push here publishes to npm (when the version changed). Protected: PR + passing CI required, no direct pushes. | merges from `develop` only |
| `develop` | Integration branch and the **default** branch. All feature work merges here first. | PR merges from `feature/*` |
| `feature/<name>` | Real development. Branch off `develop`, open a PR back into `develop`. | you |

## Day-to-day flow

```bash
git checkout develop && git pull
git checkout -b feature/my-change
# ...work, commit...
git push -u origin feature/my-change
# open a PR into develop — CI must pass to merge
```

To cut a release:

```bash
# from develop, open a PR into master
# bump the version in package.json (npm version patch|minor|major --no-git-tag-version)
# when the PR merges to master, the Release workflow publishes to npm,
# tags vX.Y.Z, and creates the GitHub Release automatically.
```

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on `develop`, `feature/**`, and PRs into
  `develop`/`master`: `npm ci`, `npm audit --audit-level=high`, `tsc --noEmit`, and a
  boot smoke test. Runs on the self-hosted runner labelled `restwalker` (epyc2).
- **Release** (`.github/workflows/release.yml`) runs on pushes to `master`. It publishes
  to npm **only if `package.json`'s version isn't already on the registry**, then tags
  and creates a GitHub Release. So non-version commits to `master` are safe no-ops.

The release needs an `NPM_TOKEN` repository secret (an npm automation token for the
package owner).

> Note: the runner is self-hosted on a public repo. Fork-PR jobs are guarded off
> (`if:` same-repo) and Actions is set to require approval for outside contributors.
