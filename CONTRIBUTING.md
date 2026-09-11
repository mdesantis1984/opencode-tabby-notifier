# Contributing

## Setup

```sh
npm ci --legacy-peer-deps
npm test
npm run test:tabby
npm run typecheck
npm run build:tabby
```

## Branching model

This repository uses classic GitFlow with two protected long-lived branches:

| Branch | Purpose | Accepted pull requests |
|---|---|---|
| `main` | Stable, releasable history | `develop`, `release/*`, or `hotfix/*` |
| `develop` | Integration for the next release | Short-lived work branches, Dependabot, or `main` synchronization |

For ordinary work:

1. Update local `develop` from `origin/develop`.
2. Create `feat/*`, `fix/*`, `docs/*`, `test/*`, `refactor/*`, `chore/*`, `ci/*`, `build/*`, `style/*`, or `perf/*` from `develop`.
3. Open the pull request against `develop` and link an approved issue.
4. Promote a releasable `develop` state to `main` through a pull request.

Create urgent `hotfix/*` branches from `main` and merge them back to `main`.
Then synchronize `main` into `develop` through a pull request. Use `release/*`
only when release stabilization must continue independently from new work on
`develop`. Never push directly, force-push, or delete either long-lived branch.
Merged short-lived remote branches are deleted automatically.

Run the relevant harness when changing a runtime boundary. Do not include
credentials, full paths, screenshots with personal context, generated bundles,
crash reports, or local configuration in a change.

## Boundaries

The root package owns OpenCode event filtering and delivery adapters. The
`tabby-plugin` workspace owns Angular integration, the loopback listener, tab
registry, and recovery behavior. Keep the shared completion contract metadata-
only and preserve primary-session filtering, HMAC verification, correlation,
freshness, and replay semantics.

## Review and work units

Make each commit one independently understandable work unit; keep its tests
and user-facing documentation with the behavior they verify. Use Conventional
Commit messages. Explain runtime verification and rollback boundaries in the
PR. Security-sensitive changes require focused review of data disclosure,
command execution, IPC validation, and package contents.

Every pull request must use an allowed source/base route, include `Closes #N`
for approved issue `N`, and carry exactly one `type:*` label. CI and PR policy
checks must pass before merge. Package publication is restricted to `main`.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
