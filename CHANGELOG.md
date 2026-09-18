# Changelog

## 1.2.0

- Extract the bridge into the independently maintained MIT-licensed desirecore-agent/desirecore-cdp-mcp repository.
- Ship a compiled Node CLI with a Windows-compatible npm bin; tsx, Electron and the DesireCore source tree are not runtime requirements.
- Keep zero-instance startup, automatic multi-instance discovery, generation-bound routing, readonly defaults and authenticated Streamable HTTP/stdio.
- Preserve page CDP sessions across calls so DOM node IDs remain usable for subsequent queries and input.
- Retain failed-generation records when an idle connection disappears from the registry; never reconnect it silently.
- Add standalone tests, clean-package installation smoke checks, CI, versioned Release artifacts and Registry integration guidance.

## 1.1.0 (pre-extraction)

Independent multi-instance bridge implemented in DesireCore PR #3112; not a public npm registry release.
