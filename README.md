# chat2shell

`chat2shell` is a private MCP gateway for using controlled shell and, later, isolated sandbox capabilities from ChatGPT.

The initial version preserves the existing CodexPro tool contract so the already registered ChatGPT app continues to work. It adds a stable gateway boundary where authentication, approvals, persistent workspace identities, sandbox lifecycle management, and monitoring can be introduced one decision at a time.

## Current architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client (outbound connection)
  -> chat2shell gateway (127.0.0.1:18788)
  -> CodexPro 0.30.0 (127.0.0.1:18787)
  -> host workspace
```

The gateway currently performs the narrow `server/discover` compatibility handling required by the tunnel and proxies all normal MCP traffic to CodexPro. It deliberately does not add or rename any tools yet.

## Boundaries

- `src/mcp`: the public MCP transport and compatibility boundary.
- `src/auth`: an authentication provider contract. The active provider is intentionally single-user; OAuth is not implemented yet.
- `src/workspaces`: stable workspace aliases for future state that must survive individual tunnel requests.
- `src/sandbox`: the sandbox lifecycle contract. No sandbox tools are exposed yet.
- `scripts`: local process supervision and Secure MCP Tunnel wiring.

Secrets remain outside the repository under `/home/retn0/.secrets/tunnel-client` by default. The tunnel API key is passed to `tunnel-client` as a file reference and is never loaded by the TypeScript application.

## Development

```bash
pnpm install
pnpm check
```

Run a local-only stack on the default ports:

```bash
CHAT2SHELL_ENABLE_TUNNEL=0 ./scripts/run.sh
```

Run the tunnel-backed stack used by the registered ChatGPT app:

```bash
./scripts/run.sh
```

Inspect or stop it with:

```bash
./scripts/status.sh
./scripts/stop.sh
```

Runtime settings can be overridden with the variables documented in `.env.example`. `.env` files are ignored, but tunnel credentials should continue to live in the external secret directory rather than an environment file.

## Deliberately deferred

- OAuth and multi-user identity.
- Approval records for host mounts and high-impact actions.
- Docker sandbox create, inspect, execute, and destroy tools.
- Persistent state storage and a monitoring dashboard.
- Reboot persistence or a system service.

These are deferred so each capability can be designed and tested against actual usage without changing the tunnel or public MCP boundary again.
