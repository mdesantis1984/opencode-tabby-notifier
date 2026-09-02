# Installation

## Local development (before npm publication)

From the repository root:

```sh
npm ci --legacy-peer-deps
npm run build:tabby
```

Copy `src/index.ts` to the OpenCode plugin directory. On Linux/macOS use
`~/.config/opencode/plugins/`; on Windows use
`%USERPROFILE%\\.config\\opencode\\plugins\\`. Alternatively configure the
absolute repository path in OpenCode's plugin list. Install the Tabby package
from its absolute local path:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/tabby/plugins"
npm install --legacy-peer-deps /absolute/path/to/tabby-plugin
```

On Windows, run the equivalent in PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\tabby\plugins"
npm install --legacy-peer-deps C:\path\to\opencode-tabby-notifier\tabby-plugin
```

For macOS, use `~/Library/Application Support/Tabby/plugins` when managing
Tabby's application data manually. Follow the installed Tabby build's plugin
directory convention if it differs.

## npm installation (after publication)

```sh
npm install opencode-tabby-notifier
npm install --legacy-peer-deps tabby-opencode-notifier
```

Add the OpenCode package to the OpenCode plugin configuration and enable the
Tabby package in Tabby. These commands are intentionally future-facing until
the packages have been published.

## Runtime variables

Set variables in the OpenCode process environment, not in tracked files or
Tabby profiles:

```text
OPENCODE_NOTIFY_CORRELATION=tabby-profile-id
OPENCODE_NOTIFY_IPC_ENDPOINT=http://127.0.0.1:PORT/
OPENCODE_NOTIFY_IPC_SECRET=generate-a-random-secret
OPENCODE_NOTIFY_PROJECT_LABEL=optional-stable-label
OPENCODE_NOTIFY_TELEGRAM_TOKEN=optional-bot-token
OPENCODE_NOTIFY_TELEGRAM_CHAT_ID=optional-chat-id
```

The endpoint, correlation, and secret must be paired with the matching Tabby
launch. Telegram is cross-platform. `notify-send` is Linux-only and is a
no-op elsewhere.

## Tab states

The Tabby indicator follows the producer's per-session state machine: working,
waiting for permission, waiting for a question, retrying, error, and completed.
All states are actionable and remain visible until that session's tab is
focused. Linux live end-to-end verification is available; Windows and macOS
core behavior is designed cross-platform but is not live-tested in this
project.
