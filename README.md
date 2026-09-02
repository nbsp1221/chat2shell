# chat2shell

`chat2shell` gives a private ChatGPT app full shell and Docker capabilities inside disposable Docker Sandbox microVMs without exposing the host shell or host Docker daemon.

## Architecture

```text
ChatGPT conversations
  -> OpenAI Secure MCP Tunnel
  -> chat2shell MCP control plane (host, loopback only)
       -> SQLite workspace, approval, and sandbox registry
       -> one Docker Sandbox microVM per sandbox_id
            -> one foreground CodexPro process
            -> one approved workspace
            -> one private Docker Engine
```

The host process exposes five lifecycle tools and a static contract for eighteen relevant CodexPro tools.
Every CodexPro tool has an additional required `sandbox_id`; chat2shell strips that routing field and forwards the remaining arguments to CodexPro inside the selected microVM.
Calls to the same sandbox are serialized, while different conversations can reuse the same stable ID returned by `sandbox_list`.

The static contract deliberately excludes CodexPro's generic supertool, self-test, and workspace-switching tool because they duplicate visible tools or bypass the sandbox's assigned workspace. CodexPro is installed only in the sandbox template; the host application does not import or execute it.

## Current policy

This section is the complete product policy. A behavior that contradicts it is a bug; a new behavior must be added here when it is introduced.

### Authority

- CodexPro never runs on the host.
- ChatGPT cannot invoke raw `sbx`, host shell commands, sudo, or the host Docker socket.
- A sandbox receives full shell and sudo-equivalent freedom only inside its microVM, including its own Docker Engine.
- Bash is unrestricted inside the sandbox. Commands can modify sandbox files, install packages, access the network, and control the sandbox's private Docker Engine.
- chat2shell does not ask for local approval for ordinary sandbox work. Creating a new host-backed workspace is the only local approval boundary.
- The server has no OAuth and treats every request as `local-owner`. The tunnel and ChatGPT app must remain private to the owner.

### Workspaces

- A managed workspace is the only host path mounted automatically.
- An arbitrary `workspace_path` creates a pending approval and never mounts the path by itself.
- Host paths must already exist and resolve strictly below `CHAT2SHELL_ALLOWED_HOST_ROOTS`. Paths containing `.aws`, `.azure`, `.config`, `.docker`, `.gnupg`, `.kube`, `.local`, `.secrets`, or `.ssh` are rejected.
- `clone` is the default mode for host repositories and keeps edits in a private VM clone.
- `direct` provides read-write access to exactly one locally approved host directory.
- A host workspace approval is stored and reused; chat2shell does not ask again for the same path and mode.
- One workspace can have one running sandbox. Repeating `sandbox_create` for it reuses that sandbox.
- Managed workspace and state directories use owner-only permissions. The SQLite database file uses mode `0600`.

### Network and credentials

- Outbound network access follows the Docker Sandboxes policy installed on this machine. The current prototype intentionally permits general network access.
- chat2shell denies `openrouter.ai` for its sandboxes so Docker's unrelated global `opencodex` credential cannot be used by ChatGPT.
- Docker's built-in MCP gateway may exist inside a shell sandbox, but chat2shell and CodexPro do not connect to it.
- CodexPro endpoints use random bearer tokens and dynamically allocated loopback ports.
- The internal bearer token is stored in the owner-only SQLite state file and is never returned through MCP.
- Tunnel credentials remain outside this repository and are never read by the TypeScript application.

### Lifecycle and failure

Calling `sandbox_create` without a path creates two independent identities:

```text
sandbox_id:   sbx_...
workspace_id: ws_...
workspace:    ~/.chat2shell/workspaces/ws_...
```

CodexPro runs as one foreground `sbx exec` session owned by chat2shell. That session keeps the microVM running; there is no second supervisor and no automatic restart.

The sandbox expires after 30 minutes of inactivity and has a four-hour hard lifetime. Expiration is checked between calls and never interrupts a command already running. Successful tool calls renew only the idle deadline; failed calls do not.

Cleanup checks run once per minute. Each sandbox receives 2 CPUs and 4 GiB of memory. Bash commands default to a 30-second timeout and may request up to 10 minutes. The outer MCP server accepts request bodies up to 20 MiB.

If CodexPro becomes unavailable, the sandbox changes to `failed`. `sandbox_list` shows it, and the user must destroy it before creating a replacement. chat2shell does not guess how to recover it.

Restarting chat2shell invalidates existing sandboxes because their foreground sessions belonged to the old controller. On the next start, chat2shell removes those microVMs and reports their records as `failed`. Reboot persistence is not implemented.

Destroying an active sandbox removes its microVM but retains a managed workspace for seven days so a new sandbox can attach using the same `workspace_id`.
After seven days, the reaper moves it to `~/.chat2shell/trash`. chat2shell does not empty that trash. Registered host workspaces are never deleted.

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
pnpm cli workspace add /path/to/repository --mode clone
pnpm cli workspace add /path/to/repository --mode direct
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

Other conversations connected to the same private app can find and reuse it:

```text
sandbox_list -> sandbox_get -> read/search/bash/... with sandbox_id
```

Available management tools are `sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_destroy`, and `workspace_list`.

## Configuration

`.env.example` contains deployment locations and the tunnel switch. Sandbox authority and lifetime values are fixed policy, not environment-specific behavior.

Current locations are:

- data: `~/.chat2shell`
- state database: `~/.chat2shell/state/chat2shell.sqlite`
- managed workspaces: `~/.chat2shell/workspaces`
- host allow root: `~/repositories`

The fixed template, resource limits, timeouts, and retention values are listed in Current policy above.

OAuth, reboot persistence, the monitoring dashboard, and a browser approval UI do not exist. They will be considered only after the current prototype proves useful.

## License

chat2shell is available under the MIT License. See `THIRD_PARTY_NOTICES.md` for bundled third-party notices.
