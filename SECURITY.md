# Security policy

## Supported versions

Only the latest published minor release is supported. The current `0.1.x`
line is unreleased and receives security fixes while it is maintained.

## Reporting

Use GitHub's private vulnerability reporting for this repository. If it is not
enabled, contact the repository owner through a private GitHub channel before
disclosure. Do not put secrets, tokens, private paths, payloads, or exploit
details in public issues, pull requests, or logs.

## Threat model and trust boundary

This software runs as an OpenCode and Tabby plugin with the privileges of both
hosts. Treat installed plugins and npm dependencies as trusted code. The IPC
listener accepts only loopback traffic, bounded fresh frames, strict identifier
shapes, matching HMACs, and the expected correlation ID. Replay identifiers are
expired and deterministically capped. Child sessions are filtered.

The system does not provide process sandboxing, host compromise protection, or
confidentiality from a local attacker who can read the runtime environment or
control the host. Keep Telegram credentials and IPC secrets in a protected
secret manager and rotate them if exposure is suspected.

## Dependency audit policy

The published archives contain no bundled third-party dependency (`bundled` is
empty); the root producer declares OpenCode as a peer and the Tabby bundle
externalizes Tabby's host modules. CI therefore gates the shipped graph with
`npm audit --omit=dev` and also records the full audit. The current development
graph still reports Angular/Tabby host advisories because Tabby 1.0.235 exposes
an Angular 15-compatible, pinned host contract; upgrading those packages would
break compatibility. These are accepted host/dev-only findings, not hidden
exceptions, and must be re-evaluated before each release. The development-only
webpack advisory was remediated by upgrading webpack to 5.104.1.

## Privacy rules

Completion and state events contain only bounded labels, opaque IDs, state or
outcome, generation, and time.
They must never contain prompts, output, model/provider data, environment
values, session files, or full working-directory paths.
