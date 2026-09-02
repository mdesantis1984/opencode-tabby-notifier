# Tabby OpenCode Notifier

Tabby plugin consumer for `opencode-tabby-notifier`. It registers the notifier
profile, accepts authenticated loopback per-session state events, and keeps the
state-specific indicator visible until focus acknowledges it. It renders
working, permission/question waits, retrying, errors, and completed sessions.

Install this package after the OpenCode producer and configure matching
correlation and IPC secret values. See the repository
[installation guide](../docs/INSTALLATION.md) and [security policy](../SECURITY.md).
