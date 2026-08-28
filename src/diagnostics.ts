const sensitive = /(token|secret|password|chat[_ -]?id|path|endpoint|content|cwd|directory)\s*[=:]\s*[^\s]+/i
export function redact(value: string): string { return sensitive.test(value) || /(?:\/|[A-Za-z]:\\)/.test(value) ? "[redacted]" : value }
export function diagnostic(code: string, _error?: unknown): { code: string; status: "rejected" } { return { code: redact(code), status: "rejected" } }
