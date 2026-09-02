# Contributing

## Setup

```sh
npm ci --legacy-peer-deps
npm test
npm run test:tabby
npm run typecheck
npm run build:tabby
```

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

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
