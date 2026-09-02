# Architecture

```text
OpenCode official session/permission/question/retry/error boundaries
  -> primary-session filter and per-session generation state machine
  -> bounded state event
  -> HMAC-authenticated loopback HTTP
  -> Tabby IPC server and correlation registry
  -> persistent green bell until target-tab focus
```

The producer ignores child sessions using explicit parent fields and a session
metadata lookup. Status generations prevent duplicate delivery during a single
run. Events contain a bounded project label rather than a working directory.

The consumer binds each launch to a correlation ID, validates freshness,
identifier shape, frame size, HMAC, loopback origin, and replay state, then maps
the event to the registered Tabby tab. Split tabs and recovery tokens preserve
  the correlation mapping without storing runtime secrets. If a delivery arrives
  before a tab is registered, the bounded runtime manager allows a short recovery
  window; unknown or stale deliveries are rejected.

## State projection

The OpenCode plugin is the single writer. Tabby never infers state from PTY
output; it renders the authenticated projection below and acknowledges it when
the target tab receives focus.

| State | Official boundary | Icon and color |
|---|---|---|
| working | `session.status=busy` | `fas fa-spinner`, blue `#337ab7` |
| waiting-permission | `permission.asked` | `fas fa-hand-paper`, amber `#f0ad4e` |
| waiting-question | `question.asked` | `fas fa-question-circle`, amber `#f0ad4e` |
| retrying | retry event/status | `fas fa-redo`, violet `#8e44ad` |
| error | error event/status | `fas fa-exclamation-triangle`, red `#d9534f` |
| completed | `session.idle` | `fas fa-bell`, green `#5cb85c` |
