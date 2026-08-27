# OpenCode Tabby Notifier

Small TypeScript ESM plugin for OpenCode. The current implementation sends a
native Linux desktop notification when a primary session emits
`session.idle`; child sessions are ignored when OpenCode reports a parent
session.

This repository is currently an **OpenCode plugin**, not a Tabby plugin. The
project roadmap plans to add two more notification channels:

1. Telegram notifications.
2. A Tabby plugin that changes the relevant terminal tab icon or activity state.

Those channels are not implemented yet. No Telegram credentials or Tabby
installation are required by the current implementation.

## Requirements

- Node.js 20 or newer
- Linux desktop notification service
- [`notify-send`](https://manpages.debian.org/notify-send) available on `PATH`
- OpenCode with TypeScript plugin support

## Local installation

From this directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp src/index.ts ~/.config/opencode/plugins/opencode-tabby-notifier.ts
```

Then start OpenCode normally. OpenCode discovers the plugin from its plugins
directory; no Tabby installation or configuration is required.

## Package installation

```sh
npm install opencode-tabby-notifier
```

Add `opencode-tabby-notifier` to the OpenCode plugin list in your OpenCode
configuration.

## Development

```sh
npm ci
npm test
npm run typecheck
```

Notification failures are logged and never interrupt an OpenCode run.
