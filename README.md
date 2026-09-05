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

The host process exposes six management tools, eighteen relevant CodexPro tools, and two Bash session controls.
Every tool that operates inside a sandbox requires `sandbox_id`. chat2shell forwards ordinary CodexPro calls into the selected microVM and adapts Bash calls into bounded MCP requests without changing where commands execute.
Calls to the same sandbox are serialized, while different conversations can reuse the same stable ID returned by `sandbox_list`.

The static contract deliberately excludes CodexPro's generic supertool, self-test, and workspace-switching tool because they duplicate visible tools or bypass the sandbox's assigned workspace. CodexPro is installed only in the sandbox template; the host application does not import or execute it.

## Current policy

This section describes the user-visible authority, workspace, network, credential, and lifecycle guarantees enforced by chat2shell.

### Authority

- CodexPro never runs on the host.
- ChatGPT cannot invoke raw `sbx`, host shell commands, sudo, or the host Docker socket.
- A sandbox receives full shell and sudo-equivalent freedom only inside its microVM, including its own Docker Engine.
- Bash is unrestricted inside the sandbox. Commands can modify sandbox files, install packages, access the network, and control the sandbox's private Docker Engine.
- chat2shell does not ask for local approval for ordinary sandbox work. Creating a new host-backed workspace is the only local approval boundary.
- The server has no authentication and treats every request as `local-owner`. Secure MCP Tunnel is the recommended transport. Any other exposure must provide its own authentication and access control; never expose the MCP endpoint directly to an untrusted network.

### Workspaces

- A managed workspace is the only host path mounted automatically.
- An arbitrary `workspace_path` creates a pending approval and never mounts the path by itself.
- Host paths must already exist and resolve strictly below `CHAT2SHELL_ALLOWED_HOST_ROOTS`. Paths containing `.aws`, `.azure`, `.config`, `.docker`, `.gnupg`, `.kube`, `.local`, `.secrets`, or `.ssh` are rejected.
- `clone` is the default mode for host repositories and keeps edits in a private VM clone.
- `direct` provides read-write access to exactly one locally approved host directory.
- A host workspace approval is stored and reused; chat2shell does not ask again for the same path and mode.
- One workspace can have one running sandbox. Repeating `sandbox_create` for it reuses that sandbox.
- The number of active sandboxes is unlimited unless the operator sets `maxActiveSandboxes`. Creating, running, and destroying sandboxes count toward that limit; reuse and destruction remain available at the limit.
- Managed workspace and state directories use owner-only permissions. The SQLite database file uses mode `0600`.

### Network and credentials

- General outbound network access follows Docker Sandboxes behavior.
- chat2shell does not add, remove, or override Docker Sandboxes network policy.
- `sandbox_expose` publishes one sandbox TCP port on an automatically assigned port on every host IPv4 interface. It is never called automatically, adds no authentication or expiration, and relies on the sandboxed service listening on `0.0.0.0`.
- Repeating `sandbox_expose` for the same sandbox port returns the existing mapping. The mapping disappears when the sandbox is removed.
- Traffic through an exposed port does not count as a tool call and does not renew the sandbox inactivity deadline.
- Docker's built-in MCP gateway may exist inside a shell sandbox, but chat2shell and CodexPro do not connect to it.
- CodexPro endpoints use random bearer tokens and dynamically allocated loopback ports.
- The internal bearer token is stored in the owner-only SQLite state file and is never returned through MCP.
- Tunnel credentials remain outside the npm package. chat2shell reads the tunnel ID and gives tunnel-client the key file path without exposing either value through MCP.

### Lifecycle and failure

Calling `sandbox_create` without a path creates two independent identities:

```text
sandbox_id:   sbx_...
workspace_id: ws_...
workspace:    ~/.chat2shell/workspaces/ws_...
```

CodexPro runs as one foreground `sbx exec` session owned by chat2shell. That session keeps the microVM running; there is no second supervisor and no automatic restart.

The complete automatic lifetime policy is intentionally small:

- A sandbox is removed after 24 hours without a tool call.
- A sandbox that keeps receiving tool calls has no maximum lifetime.
- A managed workspace is retained for 30 days after its sandbox is removed.
- After 30 days, the managed workspace is moved to `~/.chat2shell/trash`.

Every tool call that reaches a running sandbox counts as activity, whether it succeeds or fails. Expiration is checked between calls and never interrupts a command already running. The trash directory is not emptied automatically. Host workspaces are outside chat2shell's ownership and are never moved or deleted.

Cleanup checks run once per minute. Sandbox resources use Docker Sandboxes defaults unless `sandbox_create.memory` sets a memory ceiling for one new sandbox. The outer MCP server accepts request bodies up to 20 MiB.

Bash has no execution timeout unless `timeout_ms` is explicitly provided. `bash` always returns a `session_id` and waits up to `yield_time_ms`, which defaults to 10 seconds and accepts at most 60 seconds. If command launch succeeds but the initial status/output snapshot cannot be read, `bash` preserves the session and conservatively returns `status: running` with no output so the caller can recover with `bash_poll`. `bash_poll` waits for new output, process exit, or its own `yield_time_ms` expiry; that wait also defaults to 10 seconds and accepts at most 60 seconds. It returns only new combined stdout/stderr. Poll again while `status` is `running` or `has_more_output` is true. `bash_stop` sends SIGTERM followed by SIGKILL after 1.5 seconds if necessary. chat2shell does not redact Bash output: everything printed inside the sandbox is visible to the MCP client. Sensitive data must be controlled by the files and credentials explicitly made available to the sandbox. Bash sessions exist only in their sandbox and disappear when that sandbox is removed. They are not recovered after a chat2shell restart, because restart reconciliation removes the old sandbox.

If CodexPro becomes unavailable, the sandbox changes to `failed`. `sandbox_list` shows it, and the user must destroy it before creating a replacement. chat2shell does not guess how to recover it.

Restarting chat2shell invalidates existing sandboxes because their foreground sessions belonged to the old controller. On the next start, chat2shell removes those microVMs and reports their records as `failed`. Reboot persistence is not implemented.

Destroying an active sandbox follows the same workspace policy, so a managed workspace can be attached to a new sandbox with the same `workspace_id` during its 30-day retention period.

## Install and run

Requirements are Node.js 24 or newer and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`). Tunnel mode additionally requires Secure MCP Tunnel access, its client, a tunnel ID, and a key file.

Install the CLI and prepare its pinned CodexPro sandbox template:

```bash
npm install --global chat2shell
chat2shell setup
```

`setup` checks the required local tunnel files and Docker Sandboxes installation. It creates `chat2shell-codexpro:0.30.0` only when that template does not already exist. The template contains CodexPro and its npm dependencies, but no workspace, application source, credentials, or tunnel secret.

Run chat2shell in the foreground:

```bash
chat2shell serve
```

The `serve` process owns both the loopback MCP gateway and tunnel-client. It first reconciles sandbox state, then opens the gateway and starts the tunnel. It has no startup timeout, daemon mode, automatic restart, or service installation. Use `Ctrl+C` to stop an interactive process or let an external service manager supervise the same foreground command.

Opening the writable state database automatically applies every pending schema migration in one transaction before application logic runs. Upgrading the package therefore requires no separate database command or manual SQL.

Inspect a running instance from another terminal:

```bash
chat2shell status
```

Run locally without opening the tunnel:

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 chat2shell setup
CHAT2SHELL_ENABLE_TUNNEL=0 chat2shell serve
```

The MCP endpoint binds to loopback by default. If you publish it through a reverse proxy, another tunnel, or a non-loopback bind, you are responsible for authenticating and restricting that route.

Update an npm installation through the package manager that owns it:

```bash
npm update --global chat2shell
```

chat2shell intentionally has no self-update command.

## Development

```bash
pnpm install
pnpm check
pnpm test:e2e
```

`pnpm check` is the normal development and CI quality gate: formatting, linting, typechecking, unit and integration tests, and the production bundle. It deliberately excludes real Docker Sandbox E2E tests. Run `pnpm test:e2e` on a trusted host with `sbx` and the local CodexPro template installed. See [`test/README.md`](./test/README.md) for the test boundaries and individual commands.

## Host workspace approval

When ChatGPT requests a new host path, `sandbox_create` returns an `approval_id` instead of creating a sandbox.
Review and decide it locally:

```bash
chat2shell approval list
chat2shell approval approve approval_...
chat2shell approval reject approval_...
```

A host operator can also register a path directly:

```bash
chat2shell workspace add /path/to/repository --mode clone
chat2shell workspace add /path/to/repository --mode direct
chat2shell workspace list
```

After approval, call `sandbox_create` with the returned `workspace_id`.
Use `direct` only when immediate edits to the host checkout are intended.
Full bash inside a direct sandbox can modify every file in that approved directory, including repository metadata such as `.git`.
Unexported changes in a private clone disappear when its sandbox is destroyed, so commit and fetch them before deletion.

## MCP workflow

```json
{ "workspace_mode": "managed", "memory": "4g" }
```

`memory` is optional and accepts positive binary megabytes or gigabytes such as `512m` or `4g`. When omitted, chat2shell does not pass a memory setting to Docker Sandboxes. An existing sandbox can be reused without repeating `memory`; requesting a different limit requires destroying it first.

Pass the returned sandbox ID to every CodexPro tool:

```json
{ "sandbox_id": "sbx_...", "command": "pnpm test" }
```

Long commands use the same `bash` tool. A running result includes a session ID for later output or termination:

```text
bash -> { "session_id": "bash_...", "status": "running", "output": "..." }
bash_poll -> { "sandbox_id": "sbx_...", "session_id": "bash_...", "yield_time_ms": 10000 }
bash_stop -> { "sandbox_id": "sbx_...", "session_id": "bash_..." }
```

To view a web application, start it on every sandbox interface and expose its port:

```text
bash -> pnpm dev --host 0.0.0.0
sandbox_expose -> { "sandbox_id": "sbx_...", "port": 3000 }
```

Connect to the returned `hostPort` through any network path that already reaches the host. chat2shell does not discover host addresses, create URLs, or manage a reverse proxy.

Other conversations connected to the same private app can find and reuse it:

```text
sandbox_list -> sandbox_get -> read/search/bash/... with sandbox_id
```

Available management tools are `sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_expose`, `sandbox_destroy`, and `workspace_list`.

## Configuration

`.env.example` contains deployment locations, the tunnel switch, and the optional active sandbox limit. Sandbox authority and lifetime values are fixed policy, not environment-specific behavior.

Current locations are:

- data: `~/.chat2shell`
- state database: `~/.chat2shell/state/chat2shell.sqlite`
- managed workspaces: `~/.chat2shell/workspaces`
- host allow root: `~/repositories`

An optional `~/.chat2shell/config.json` can limit sandboxes managed by this chat2shell instance:

```json
{
  "maxActiveSandboxes": 4
}
```

Omitting the field means unlimited. `0` prevents new sandbox creation. `CHAT2SHELL_MAX_ACTIVE_SANDBOXES` overrides the file with a non-negative integer; `unlimited` explicitly overrides a file limit. Configuration is read at process start, so changes take effect after restarting `chat2shell serve`. `chat2shell status` shows the effective limit and active count.

The pinned template, Bash session behavior, and retention values are listed in Current policy above. CPU and disk always use Docker Sandboxes defaults. Memory also uses that default unless a caller explicitly supplies `sandbox_create.memory`. chat2shell does not inspect or modify cgroups, calculate host memory availability, reserve memory, or automatically resize or remove sandboxes.

## License

chat2shell is available under the MIT License. See `THIRD_PARTY_NOTICES.md` for bundled third-party notices.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the intended product direction.
