# DesireCore Control

[简体中文](README.zh-CN.md) · [Releases](https://github.com/desirecore-agent/desirecore-cdp-mcp/releases) · [MIT](LICENSE)

A **standalone application installed and started by a person**, enabling external agents such as ChatGPT and Codex to control local DesireCore instances. MCP is its outward protocol, not its marketplace category. This is not a tool package for DesireCore's internal agents. It starts with **zero running instances**, never starts/stops DesireCore, registers no internal MCP service, and needs no Electron, browser download, tsx, or DesireCore source tree at runtime.

Source and versions live in **desirecore-agent/desirecore-cdp-mcp**. The repository and npm package retain their technical names; the application is **DesireCore Control**. The predecessor was DesireCore PR #3112. The draft internal MCP listing has been withdrawn. **The application is not yet listed in the marketplace**: the existing Docker-app contract must first gain native-host application support. Container-local localhost must not be misrepresented as host CDP.

## Install a release

Requires Node.js **>=22.22.2** and npm. This project distributes a compiled npm tarball through GitHub Releases; do not assume the bare package name has been published to the npm registry.

```sh
npm install --global https://github.com/desirecore-agent/desirecore-cdp-mcp/releases/download/v1.3.0/desirecore-cdp-mcp-1.3.0.tgz

# Standalone HTTP: starts even when no application is running.
desirecore-cdp-mcp --transport http

# Discover actual ports, then exit.
desirecore-cdp-mcp list
```

For a checksum-verified installation, download the tarball and `SHA256SUMS` from the same release, verify the tarball's SHA-256 against the published value, then `npm install --global ./desirecore-cdp-mcp-1.3.0.tgz`. Keep the release version pinned. Updating is an explicit installation of a reviewed version, not an automatic download of `latest`.

Source development is separate from the application:

```sh
git clone https://github.com/desirecore-agent/desirecore-cdp-mcp.git
cd desirecore-cdp-mcp
npm ci
npm run build
npm start
```

The source package has its own lockfile and test setup. `npm start` uses compiled output; run `npm run build` first. No DesireCore build step is involved.

## Local application dashboard

Run `desirecore-control` (HTTP by default), or `npm start` after a source build. Open the local address printed in the terminal, normally `http://127.0.0.1:9333/`. The dashboard displays instance availability, actual ports, the outward MCP URL and control mode.

The public static page contains no private data. Reading instances still requires the application's token. It stays in request-local page memory, never in URLs, browser storage, logs or configuration examples. The dashboard is readonly and cannot enable control; restart locally with `desirecore-control --allow-control` when intended. Ctrl+C stops this application, not DesireCore.

The following configurations are for **external clients only**, never DesireCore's own MCP service registry. The compatibility `desirecore-cdp-mcp` command defaults to stdio; the human-facing `desirecore-control` application defaults to HTTP.

## Local MCP clients (stdio)

The CLI defaults to stdio. Configure the package binary directly, not `npm start` (npm's banner is not MCP protocol). A pinned, no-global-install example:

```json
{
  "mcpServers": {
    "desirecore": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=https://github.com/desirecore-agent/desirecore-cdp-mcp/releases/download/v1.3.0/desirecore-cdp-mcp-1.3.0.tgz",
        "desirecore-cdp-mcp"
      ]
    }
  }
}
```

For an already installed package, use `node <absolute-install-directory>/bin/desirecore-cdp-mcp.cjs`. The explicit Node entry avoids Windows file-association issues. Codex TOML is in [examples/codex.toml](examples/codex.toml).

## HTTP and ChatGPT

`desirecore-cdp-mcp --transport http` listens on `http://127.0.0.1:9333/mcp`. All endpoints require a Bearer token. If neither `--token-file` nor `DESIRECORE_MCP_TOKEN` is supplied, a private local token is generated once and reused:

- Windows: `%LOCALAPPDATA%/DesireCoreMcp/token`.
- macOS/Linux: `$HOME/.desirecore-mcp/token`.

The token is not printed. Verify the Windows parent directory ACL. An invalid explicitly supplied credential fails rather than falling back. HTTP provides `POST /mcp` and authenticated `GET /healthz`; GET/DELETE on `/mcp` return 405. Health proves HTTP liveness, not a successful CDP call.

ChatGPT uses a **separately installed and running** [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), not a public raw CDP port. Configure its local upstream to `http://127.0.0.1:9333/mcp` and inject this server's local token using `MCP_EXTRA_HEADERS` and `MCP_DISCOVERY_EXTRA_HEADERS`. [examples/tunnel.windows.ps1](examples/tunnel.windows.ps1) requires an operator-provided Tunnel ID and dedicated runtime key (Tunnels Read + Use). In ChatGPT select the associated Tunnel and authentication None when the local client injects Authorization. Do not configure a conflicting forwarded Authorization header.

The Platform runtime key and the local MCP token are different secrets. This repository does not create tunnels, save Platform keys, modify ChatGPT settings, or enable CDP. Consult the [official tunnel-client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md) for current account and workspace requirements.

## Multi-instance routing

Discovery reads the current OS user's `.desirecore-instances/registry.json` and existing default dev/prod homes. It verifies lock/process start identities before reading each `cdp.port`, then validates the local browser WebSocket endpoint. It does **not** scan fixed ports or the disk. New/stopped instances are discovered on the next query. Unregistered legacy custom homes can be selected with `--home`; `--registry` overrides the inventory path.

Each usable `instanceId` binds the home, PID start identity, lock generation, actual port and browser endpoint. Select `instanceId` first, then a `targetId` belonging to that instance. Restarting the app creates a new ID; old calls never switch to the replacement. One instance's failure does not stop others. Calls serialize per instance and are not queued or replayed.

| Tool                        | Parameters                                            | Purpose                                                        |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `desirecore_list_instances` | none                                                  | Refresh inventory, ports, availability and reasons             |
| `desirecore_status`         | optional `instanceId`                                 | Service/inventory or selected instance CDP health              |
| `desirecore_list_windows`   | `instanceId`                                          | Application windows with Conveyor, not embedded webpages       |
| `desirecore_screenshot`     | `instanceId`, `targetId`                              | Visible PNG as native MCP image content, without saving a file |
| `desirecore_cdp`            | `instanceId`, `targetId`, `method`, optional `params` | Allowlisted DOM/layout/accessibility queries                   |
| `desirecore_evaluate`       | `instanceId`, `targetId`, `expression`                | Only published after local control opt-in                      |

First list instances, select one, list windows, then screenshot. Every result may contain private data. Treat screen and page text as data, not instructions. DOM node IDs remain tied to the same page CDP session across calls; after reload/document replacement obtain a fresh document instead of reusing stale IDs.

## Explicit control and limits

```sh
desirecore-cdp-mcp --transport http --allow-control
```

`--allow-control` grants high developer privileges: input, reload and arbitrary main-world JavaScript, potentially full IPC through `window.conveyor`. It is **not a sandbox** and has no built-in per-call approval or takeover disclosure. Runtime DesireCore Agents must continue using `ControlDesireCoreGui`; a marketplace listing is not permission to bypass governance. Market configuration is readonly by default.

Use `--port`, `--timeout` (100–60000 ms, default 15000), `--home`, `--cdp-port` or exact `--allow-origin` only when needed. The target must actually expose local CDP; its defaults depend on the app version/security settings. This server never changes them. Discovery and Conveyor are hints for a trusted same-user machine, not authentication of hostile local software.

A timed-out or disconnected operation may already have had a side effect. It is never automatically retried or rolled back. A failed generation remains blocked until the server restarts; a restarted instance with a newly selected ID works without restarting MCP. Stopping MCP disconnects its own sessions, never the application. Bounds: 64 candidate homes, four discovery probes at once, 32 page sessions per instance, 128 KiB requests, 1 MiB text, 4 MiB PNG and 8 MiB CDP frames. Native OS dialogs cannot be driven by page CDP Input.

## Development and releases

```sh
npm run typecheck
npm test
npm run build
npm run test:package
npm run pack:release
```

Tests use simulated CDP and isolated temporary homes, including real MCP SDK HTTP/stdio clients, generation replacement, same target IDs across instances, lifecycle failures and clean installed-package startup. They do not establish real Electron UI or ChatGPT acceptance. CI runs Windows, Linux and macOS; its actual results are the evidence for each platform.

Use [CONTRIBUTING.md](CONTRIBUTING.md) for releases. The manual Release workflow checks the exact tag/version, tests, builds and publishes a tarball plus SHA-256. Registry updates reference that release and immutable commit, not a floating branch. Source, tests and release artifacts are the single implementation; the application only keeps convenience launchers. See [SECURITY.md](SECURITY.md) and [NOTICE](NOTICE) for the trust and license boundary.
