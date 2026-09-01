# chat2shell

`chat2shell` is a private MCP control plane that gives ChatGPT full shell and Docker capabilities inside disposable Docker Sandbox microVMs without exposing a host shell or the host Docker daemon.

## Architecture

```text
ChatGPT conversations
  -> OpenAI Secure MCP Tunnel
  -> chat2shell MCP control plane (host, loopback only)
       -> SQLite workspace, approval, and sandbox registry
       -> narrow sbx driver
            -> one Docker Sandbox microVM per sandbox_id
                 -> CodexPro HTTP MCP
                 -> approved workspace only
                 -> private Docker Engine
```

The host process exposes five lifecycle tools and the normal CodexPro tool set.
Every CodexPro tool has an additional required `sandbox_id`; chat2shell strips that routing field and forwards the remaining arguments to CodexPro inside the selected microVM.
Calls to the same sandbox are serialized, while different conversations can reuse the same stable ID returned by `sandbox_list`.

## Security boundary

- CodexPro never runs on the host.
- ChatGPT cannot invoke raw `sbx`, host shell commands, sudo, or the host Docker socket.
- A sandbox receives full shell and sudo-equivalent freedom only inside its microVM, including its own Docker Engine.
- A managed workspace is the only host path mounted automatically.
- An arbitrary `workspace_path` creates a pending approval and never mounts the path by itself.
- Host paths must resolve below `CHAT2SHELL_ALLOWED_HOST_ROOTS`; broad and credential-bearing paths are rejected.
- `clone` is the default mode for host repositories and keeps edits in a private VM clone.
- `direct` provides read-write access to exactly one locally approved host directory.
- CodexPro endpoints use random bearer tokens and dynamically allocated loopback ports.
- Tunnel credentials remain outside this repository and are never read by the TypeScript application.

This is currently a single-owner system using the fixed principal `local-owner`.
OAuth is intentionally deferred, so the Secure MCP Tunnel and ChatGPT app must remain private to the owner.

## Workspace and sandbox lifecycle

Calling `sandbox_create` without a path creates two independent identities:

```text
sandbox_id:   sbx_...
workspace_id: ws_...
workspace:    ~/.chat2shell/workspaces/ws_...
```

The sandbox expires after 30 minutes of inactivity and has a four-hour hard lifetime by default.
Tool activity renews only the idle deadline, never the hard deadline.
Destroying an active sandbox removes its microVM but retains a managed workspace for seven days so a new sandbox can attach using the same `workspace_id`.
After the retention window, the reaper moves it to `~/.chat2shell/trash`; registered host workspaces are never deleted by chat2shell.

## Setup

Requirements are Node.js 22 or newer, pnpm, Docker Sandboxes (`sbx`), and the previously installed Secure MCP Tunnel client.

```bash
pnpm install
./scripts/setup-template.sh
pnpm check
pnpm test:integration
```

`setup-template.sh` creates the local `chat2shell-codexpro:0.30.0` sandbox template once.
The template contains CodexPro and its npm dependencies, but no workspace, application source, credentials, or tunnel secret.

Run locally without opening the tunnel:

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 ./scripts/run.sh
```

Run with the configured Secure MCP Tunnel:

```bash
./scripts/run.sh
```

Inspect or stop the runtime:

```bash
./scripts/status.sh
./scripts/stop.sh
```

## Host workspace approval

When ChatGPT requests a new host path, `sandbox_create` returns an `approval_id` instead of creating a sandbox.
Review and decide it locally:

```bash
pnpm cli approval list
pnpm cli approval approve approval_...
pnpm cli approval reject approval_...
```

A host operator can also register a path directly:

```bash
pnpm cli workspace add /home/retn0/repositories/nbsp1221/example --mode clone
pnpm cli workspace add /home/retn0/repositories/nbsp1221/example --mode direct
pnpm cli workspace list
```

After approval, call `sandbox_create` with the returned `workspace_id`.
Use `direct` only when immediate edits to the host checkout are intended.
Full bash inside a direct sandbox can modify every file in that approved directory, including repository metadata such as `.git`.
Unexported changes in a private clone disappear when its sandbox is destroyed, so commit and fetch them before deletion.

## MCP workflow

```json
{"workspace_mode":"managed"}
```

Pass the returned sandbox ID to every CodexPro tool:

```json
{"sandbox_id":"sbx_...","command":"pnpm test"}
```

Other conversations can find and reuse it:

```text
sandbox_list -> sandbox_get -> read/search/bash/... with sandbox_id
```

Available management tools are `sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_destroy`, and `workspace_list`.

## Configuration

See `.env.example` for all settings.
Important defaults are:

- data: `~/.chat2shell`
- state database: `~/.chat2shell/state/chat2shell.sqlite`
- managed workspaces: `~/.chat2shell/workspaces`
- host allow root: `~/repositories`
- template: `chat2shell-codexpro:0.30.0`
- idle timeout: 30 minutes
- maximum lifetime: 4 hours
- managed workspace retention: 7 days

Reboot persistence, OAuth, the monitoring dashboard, and approval UI are deliberately deferred.
