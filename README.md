<h1 align="center">chat2shell</h1>

<p align="center"><strong>Give ChatGPT a real shell and private Docker engine without exposing your host shell or host Docker daemon.</strong></p>

<p align="center">
  <a href="https://github.com/nbsp1221/chat2shell/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/nbsp1221/chat2shell/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24" src="https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.docker.com/ai/sandboxes/"><img alt="Docker Sandboxes" src="https://img.shields.io/badge/isolation-Docker%20Sandboxes-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/nbsp1221/chat2shell?style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="./docs/architecture.md">Architecture</a> ·
  <a href="./SECURITY.md">Security</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./ROADMAP.md">Roadmap</a>
</p>

## What is chat2shell?

`chat2shell` is a lightweight MCP control plane that gives ChatGPT a capable development environment inside disposable [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVMs.

Each sandbox gets its own shell, approved workspace, CodexPro process, and private Docker Engine. The host shell and host Docker daemon stay outside the execution boundary.

### Why use it?

- **Capable by default** — run shell commands, install packages, start servers, and use Docker inside the sandbox.
- **Isolated from the host** — ChatGPT never receives raw host shell, host sudo, or host Docker access.
- **Explicit workspace access** — arbitrary host paths require approval; clone mode keeps edits private by default.
- **Built for agent workflows** — stable sandbox/workspace IDs, long-running Bash sessions, and port exposure work across conversations.

## How it works

```text
ChatGPT
  │
  │ MCP
  ▼
Secure MCP Tunnel
  │
  ▼
chat2shell (host, loopback only)
  │
  ├─ workspace / approval / sandbox registry
  │
  └─ Docker Sandbox microVM
       ├─ approved workspace
       ├─ CodexPro
       ├─ unrestricted sandbox shell
       └─ private Docker Engine
```

The diagram is intentionally simplified. See [Architecture](./docs/architecture.md) for the trust boundaries, lifecycle rules, Bash session contract, and workspace model.

## Prerequisites

- **Node.js 24+**
- **pnpm 11.23.0**
- **Docker Sandboxes** (`sbx`)
- For ChatGPT access: **OpenAI Secure MCP Tunnel** access and the tunnel client configured for your account

> [!NOTE]
> `chat2shell` is not published to npm yet. For now, run the CLI from source.

## Quick start

### 1. Clone and build

```bash
git clone https://github.com/nbsp1221/chat2shell.git
cd chat2shell
pnpm install --frozen-lockfile
pnpm build
```

### 2. Prepare the sandbox template

Start without a tunnel first to verify the local runtime:

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 pnpm cli setup
```

`setup` checks Docker Sandboxes and creates the pinned `chat2shell-codexpro:0.30.0` template when needed.

### 3. Start the MCP server

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 pnpm cli serve
```

In another terminal:

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 pnpm cli status
```

The local MCP endpoint binds to loopback by default.

### 4. Connect ChatGPT

Follow OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), configure the tunnel client, tunnel ID, and key file, then run:

```bash
pnpm cli setup
pnpm cli serve
```

By default chat2shell expects:

```text
Tunnel client   ~/.local/bin/tunnel-client
Tunnel ID       ~/.secrets/tunnel-client/tunnel-id
Tunnel key      ~/.secrets/tunnel-client/key
```

Override these locations with environment variables when your setup differs. See [Configuration](#configuration).

## Example workflow

Once connected, ChatGPT can create an isolated workspace and use the returned `sandbox_id` for subsequent tools:

```text
sandbox_create
  -> bash / read / write / search / ...
  -> bash_poll for long-running commands
  -> sandbox_expose to preview a web service
  -> sandbox_destroy when the environment is no longer needed
```

A typical long-running command looks like:

```text
bash
  -> { session_id: "bash_...", status: "running", output: "..." }

bash_poll
  -> { sandbox_id: "sbx_...", session_id: "bash_..." }
```

## Workspace modes

| Mode      | Host interaction                                 | Best for                                            |
| --------- | ------------------------------------------------ | --------------------------------------------------- |
| `managed` | chat2shell-owned persistent workspace            | Disposable or standalone agent work                 |
| `clone`   | Private clone of an approved host repository     | Safe default for existing repositories              |
| `direct`  | Read/write access to one approved host directory | Work that must immediately affect the host checkout |

`clone` is the default for approved host repositories. Use `direct` only when you intentionally want sandbox commands to modify the approved host directory.

## Security model

chat2shell is designed around a simple boundary: **the agent is powerful inside the microVM, not on the host.**

- CodexPro and unrestricted Bash run inside Docker Sandboxes, never directly on the host.
- Host paths are not mounted unless they are managed by chat2shell or explicitly approved.
- The MCP server has no built-in authentication and binds to loopback by default. Do not expose it directly to an untrusted network.
- `sandbox_expose` publishes a sandbox port without adding authentication; treat the exposed service accordingly.
- Tunnel credentials and internal CodexPro bearer tokens are not returned through MCP.

Read [Architecture](./docs/architecture.md) for the canonical technical model and [Security](./SECURITY.md) for vulnerability reporting and expected security boundaries.

## CLI

```text
chat2shell setup                         Check prerequisites and prepare the sandbox template
chat2shell serve                         Run the MCP gateway and tunnel client in the foreground
chat2shell status                        Show service, MCP, and tunnel readiness
chat2shell workspace list                List known workspaces
chat2shell workspace add <path>          Register a host workspace
chat2shell approval list                 List pending host-path approvals
chat2shell approval approve <id>         Approve a host-path request
chat2shell approval reject <id>          Reject a host-path request
```

When running from source, use `pnpm cli <command>` instead of `chat2shell <command>`.

## Configuration

The defaults are intentionally small. `.env.example` contains the complete set of environment overrides.

| Variable                        | Default                      | Purpose                                    |
| ------------------------------- | ---------------------------- | ------------------------------------------ |
| `CHAT2SHELL_HOST`               | `127.0.0.1`                  | MCP bind address                           |
| `CHAT2SHELL_PORT`               | `18788`                      | MCP port                                   |
| `CHAT2SHELL_DATA_ROOT`          | `~/.chat2shell`              | Persistent chat2shell data                 |
| `CHAT2SHELL_ALLOWED_HOST_ROOTS` | `~/repositories`             | Roots eligible for host workspace approval |
| `CHAT2SHELL_ENABLE_TUNNEL`      | `1`                          | Set to `0` for local-only mode             |
| `CHAT2SHELL_TUNNEL_CLIENT`      | `~/.local/bin/tunnel-client` | Secure MCP Tunnel client path              |
| `CHAT2SHELL_SECRET_DIR`         | `~/.secrets/tunnel-client`   | Tunnel ID/key directory                    |

## Documentation

| Document                                | Purpose                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)  | Trust boundaries, runtime ownership, workspace modes, lifecycle, and Bash sessions |
| [Security](./SECURITY.md)               | Vulnerability reporting and security scope                                         |
| [Contributing](./CONTRIBUTING.md)       | Development setup, validation, and contribution workflow                           |
| [Tests](./test/README.md)               | Unit/integration/E2E boundaries and commands                                       |
| [Roadmap](./ROADMAP.md)                 | Intended product direction                                                         |
| [Code of Conduct](./CODE_OF_CONDUCT.md) | Community participation expectations                                               |

## Project status

chat2shell is early-stage software. The core sandbox boundary and workflow are usable, but interfaces may still change as the project is tested with real users.

If you try it, bug reports and concrete workflow feedback are especially useful. Use the repository's issue templates so reports include enough context to reproduce the problem.

## License

[MIT](./LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
