# Changelog

## 1.4.0 — ChatGPT Tunnel

- Add explicit application-managed OpenAI `tunnel-client` startup with `--chatgpt-tunnel`, a fixed local MCP binding, automatic runtime/discovery authentication headers, and an OS-assigned health port.
- Add a human-only dashboard for tunnel configuration, start, stop and readiness observations, protected by a separate per-application admin token; no tunnel-management MCP tools are published.
- Keep runtime API keys in request/child-process memory or read an operator-selected file; do not persist them or forward raw child logs. Ignore unrelated inherited tunnel profiles, extra channels and API keys.
- Bound process transitions, refuse duplicate starts, reap owned children on normal application shutdown and retain local MCP availability after tunnel failures. Readiness never claims ChatGPT end-to-end acceptance.

## 1.3.0

- Define **DesireCore Control** as a standalone application for external agents, not an internal DesireCore MCP service.
- Add the HTTP-first `desirecore-control` application command and a local, readonly management dashboard.
- Add a validated application manifest forbidding autostart and internal MCP registration.
- Preserve MCP/stdio as an outward compatibility protocol; require authentication for instance data and control calls.
- Withdraw the unpublished internal MCP marketplace draft. Native application marketplace support remains a separate platform prerequisite; no Docker deployment is claimed.
- Fix macOS batch process discovery when a historical PID is invalid, while reading no command-line/environment data.

## 1.2.0

- Extract the bridge into the independently maintained MIT-licensed desirecore-agent/desirecore-cdp-mcp repository.
- Ship a compiled Node CLI with a Windows-compatible npm bin; tsx, Electron and the DesireCore source tree are not runtime requirements.
- Keep zero-instance startup, automatic multi-instance discovery, generation-bound routing, readonly defaults and authenticated Streamable HTTP/stdio.
- Preserve page CDP sessions across calls so DOM node IDs remain usable for subsequent queries and input.
- Retain failed-generation records when an idle connection disappears from the registry; never reconnect it silently.
- Add standalone tests, clean-package installation smoke checks, CI, versioned Release artifacts and Registry integration guidance.

## 1.1.0 (pre-extraction)

Independent multi-instance bridge implemented in DesireCore PR #3112; not a public npm registry release.
