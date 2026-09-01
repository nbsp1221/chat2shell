# Architecture

## Goal

Keep the existing ChatGPT-to-CodexPro workflow operational while establishing a small application boundary that can safely grow into a sandbox controller.

## Decisions

### The tunnel is infrastructure, not the application

`tunnel-client` only connects an OpenAI-hosted tunnel endpoint to one local MCP endpoint. It runs outside the TypeScript process and receives secrets by file path. `chat2shell` owns the local endpoint and the tool policy exposed through it.

### CodexPro is an internal adapter

CodexPro 0.30.0 remains the initial implementation of the current shell and repository tools. ChatGPT connects to the `chat2shell` gateway, not directly to CodexPro, so future tools and policy can be introduced without changing the tunnel registration.

### External requests must not rely on process-local workspace IDs

Tunnel requests may arrive through separate MCP sessions. Durable concepts therefore use stable aliases and will be persisted when mutation APIs are introduced. The initial `WorkspaceRegistry` establishes this contract without exposing unfinished tools.

### Authentication and authorization are separate boundaries

The initial `SingleUserAuthProvider` reflects the current private, single-owner tunnel. A future OAuth provider can establish user identity. Separate approval and authorization policy will still be required before mounting host paths or executing high-impact operations.

### Sandbox lifecycle is a domain contract

The `SandboxManager` interface defines create, list, and stop responsibilities without choosing Docker details prematurely. Tool schemas, mount approvals, expiration, cleanup, and persistence will be decided before an implementation is exposed to ChatGPT.

## Next decisions

1. Define the smallest sandbox workflow that is useful in real conversations.
2. Define explicit approval semantics for host path mounts and destructive operations.
3. Choose the state model and persistence technology after the first tool contracts are known.
4. Add OAuth only when a second user or a public endpoint creates a real identity requirement.
