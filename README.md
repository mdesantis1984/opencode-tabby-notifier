# OpenCode Tabby Notifier

OpenCode Tabby Notifier projects each primary OpenCode session into bounded
desktop, Telegram, and optional Tabby state notifications. Each Tabby tab is
written by one per-session state machine and stays actionable until focused.

## Quick path

This repository contains two packages, and both are required for the npm path:

1. Install `opencode-tabby-notifier` as the OpenCode producer.
2. Install `tabby-opencode-notifier` as the Tabby consumer.
3. Configure matching runtime variables and restart the hosts.

The packages are prepared for publication but are **not published yet**. Until
the first release, use the local installation in [Installation](docs/INSTALLATION.md).

## What it does

The OpenCode plugin listens to official session status, permission, question,
retry, error, and idle boundaries, verifies that the session is primary, and
publishes metadata-only state events. The state table is:

| OpenCode boundary | Tabby state | Indicator |
|---|---|---|
| `session.status=busy` | working | blue spinner |
| `permission.asked` | waiting-permission | amber hand |
| `question.asked` | waiting-question | amber question |
| retry boundary/status | retrying | violet redo |
| error boundary/status | error | red warning |
| `session.idle` | completed | green bell |

Only the producer state machine writes state; repeated boundaries are ignored
per session and generation. A loopback HTTP listener authenticates each event
with HMAC-SHA256 and a per-launch correlation ID. The Tabby consumer maps it to
the correct profile, including split-tab recovery.

The existing profile icon is preserved. Every actionable state remains visible
until the target tab receives focus, then the original icon/activity state is
restored.

## Platform matrix

| Capability | Linux | Windows | macOS |
|---|---:|---:|---:|
| Core Tabby bell + OpenCode loopback IPC | Fully verified | Designed cross-platform; not live-verified | Designed cross-platform; not live-verified |
| `notify-send` desktop notification | Supported | No-op | No-op |
| Telegram notification | Supported | Works when configured | Works when configured |

Linux is the only platform with live end-to-end verification in this project.
Do not treat the Windows/macOS design claim as a live compatibility guarantee.

## Installation and configuration

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for Linux, Windows, macOS,
local development, paths, and configuration syntax. Future npm commands are
marked as post-publication commands. Telegram requires both
`OPENCODE_NOTIFY_TELEGRAM_TOKEN` and `OPENCODE_NOTIFY_TELEGRAM_CHAT_ID`.

## Security model

Events contain only bounded labels and completion metadata: never prompts,
output, full paths, provider/model data, or environment values. IPC is
loopback-only, size-limited, fresh, HMAC-authenticated, correlation-bound, and
replay-protected with deterministic expiry and eviction. Child sessions are
ignored. Review [SECURITY.md](SECURITY.md) before enabling a plugin that runs
with OpenCode or Tabby privileges.

## Troubleshooting

- No bell: confirm both packages are installed, the correlation ID and secret
  match, and the Tabby profile is enabled; then restart both hosts.
- No Linux desktop popup: verify `notify-send` is on `PATH` and your desktop
  notification service is running.
- No Telegram message: verify both Telegram variables without putting them in
  Git, a profile, an issue, or a log.
- A bell remains: focus the target profile tab; persistence is intentional.

## Development

```sh
npm ci --legacy-peer-deps
npm test
npm run test:tabby
npm run typecheck
npm run build:tabby
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Publication status

- npm packages: `opencode-tabby-notifier` and `tabby-opencode-notifier`, both
  version `0.1.0`, prepared but not published.
- Tabby: automatic discovery requires an npm package with a `tabby-*` name and
  the `tabby-plugin` keyword; there is no formal submission store.
- OpenCode: install the npm package and submit an ecosystem documentation PR to
  the official `anomalyco/opencode` repository after publication.

Release and store-readiness procedures are in [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).
