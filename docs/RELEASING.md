# Releasing

This project has two independently versioned SemVer packages:

- `opencode-tabby-notifier` — OpenCode producer.
- `tabby-opencode-notifier` — Tabby consumer.

Update both changelogs/package versions deliberately, run the complete CI
suite, and inspect both `npm pack --dry-run --json` manifests. Each archive
must contain only its runtime files, documentation, and MIT license. Use npm
trusted publishing with OIDC/provenance and an npm environment requiring 2FA;
never add a long-lived npm token to GitHub secrets or this repository.

The release workflow is manual/tag-gated and cannot publish on an arbitrary
push. A maintainer must configure the npm trusted publisher and GitHub release
environment before approval.

## Store and ecosystem readiness

Tabby automatically discovers npm packages whose names use the `tabby-*`
prefix and whose keywords include `tabby-plugin`; there is no formal store
submission. OpenCode supports npm/local plugins, while ecosystem visibility is
provided by a documentation PR to `anomalyco/opencode`.

After npm publication, the ready-to-adapt OpenCode ecosystem entry is:

```json
{
  "name": "OpenCode Tabby Notifier",
  "package": "opencode-tabby-notifier",
   "description": "Privacy-conscious per-session OpenCode state notifications for Tabby, desktop, and Telegram",
  "repository": "https://github.com/mdesantis1984/opencode-tabby-notifier"
}
```

Do not open that PR before both packages are publicly installable.

## State coverage gate

Before publication, verify every state in the architecture table through the
official OpenCode SSE boundary and the real Tabby multitab DOM harness. A unit
or fake hook call is not evidence for an official state. If OpenCode does not
emit a required boundary in the isolated fixture, record the exact blocker and
keep publication blocked.
