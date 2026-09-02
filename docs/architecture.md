# Architecture

## Goal

ChatGPT can create, discover, reuse, and destroy isolated development environments, then use the existing CodexPro tools with full freedom inside a selected environment.
No request can inherit a host shell, host sudo, the host Docker socket, or an unapproved host filesystem path.

## Trust boundaries

```text
Untrusted: ChatGPT prompts and MCP arguments
    |
    v
Public policy boundary: chat2shell MCP server
    | fixed operations and stable ids only
    v
Host privilege boundary: narrow SbxDriver
    | validated workspace + fixed template/resources/port
    v
Primary execution boundary: Docker Sandbox microVM
    | full shell, workspace access, private Docker Engine
    v
Internal adapter: CodexPro
```

The Secure MCP Tunnel transports MCP messages to one loopback endpoint and does not decide tool policy.
The chat2shell process owns identity, path approval, lifecycle, expiration, and routing.
The `SbxDriver` is the only component allowed to invoke `sbx`, and it accepts structured values rather than raw arguments.

## Independent identities

`sandbox_id` identifies a disposable microVM and is required on every CodexPro tool call.
`workspace_id` identifies persistent files and can be attached to a replacement sandbox after the previous runtime expires.
Neither identity depends on a ChatGPT conversation or MCP session, so another conversation under the same authenticated principal can discover it with `sandbox_list` or `workspace_list`.

The current authentication provider maps every accepted tunnel request to `local-owner`.
A future OAuth provider will change principal establishment without changing sandbox or workspace identities.

## Workspace modes

### Managed

When no workspace is specified, chat2shell creates `~/.chat2shell/workspaces/<workspace_id>` with mode `0700` and mounts it read-write.
The path is owned by chat2shell and is safe to create without an approval.

### Clone

An approved Git repository is passed to `sbx create --clone`.
The host checkout is the read-only source of a private clone inside the microVM, so sandbox edits do not immediately affect the host checkout.
The user must commit and fetch useful changes before sandbox destruction.

### Direct

An approved host directory is mounted read-write at the same absolute path.
This is intentionally a scoped host filesystem capability, not host execution authority.
It requires local registration or approval and should be used only when immediate host checkout edits are desired.

## Approval model

The MCP API can request a host path but cannot approve it.
The path is canonicalized with `realpath`, must be a directory strictly below an allowed root, and is rejected when it contains protected credential-directory components.
A successful request creates an `approval_required` response with a stable approval ID.
Only the local CLI can approve or reject it, after which MCP callers refer to the resulting `workspace_id` instead of resubmitting a raw path.

## Sandbox creation

1. Resolve an approved workspace or create a managed workspace.
2. Reuse its active sandbox if one exists.
3. Persist a `creating` record before invoking external commands.
4. Create a named `shell` microVM from the pinned CodexPro template with fixed CPU, memory, and one dynamic loopback port.
5. Generate a random CodexPro bearer token.
6. Start CodexPro inside the microVM with full bash, workspace writes, and only the sandbox workspace as an allowed root.
7. Verify its authenticated health endpoint and persist the endpoint and token in the mode-`0600` SQLite database.
8. Return a safe summary that omits the token, endpoint, runtime name, and runtime path.

Failures remove a partially created runtime and persist a `failed` record for diagnosis.

## CodexPro routing

chat2shell loads a pinned static copy of the supported CodexPro tool descriptors; it does not import, start, or inspect CodexPro on the host.
It adds a required `sandbox_id` to every schema while retaining the original tool name, description, annotations, attachment metadata, and CodexPro arguments.

For each call, chat2shell validates ownership, expiration, and CodexPro health, removes the outer `sandbox_id`, and forwards the call through an authenticated MCP session to CodexPro inside that microVM.
Calls are serialized per sandbox to prevent concurrent conversations from racing on session selection or writes.

CodexPro assigns its own path-derived workspace ID inside the microVM. That internal ID is not part of the chat2shell contract, so chat2shell replaces it in tool results with the persistent public `workspace_id` associated with the sandbox.

## Expiration and failure

The lifecycle policy has four rules: a sandbox is removed after 24 hours without a tool call; an active sandbox has no maximum lifetime; a managed workspace is retained for 30 days after sandbox removal; and an expired managed workspace is moved into chat2shell's recoverable trash directory.
Every tool call that reaches a running sandbox renews its idle deadline, whether the call succeeds or fails.
The trash directory is not emptied automatically. Host workspaces are never moved or deleted because chat2shell does not own them.

At controller startup, persisted active records are reconciled with `sbx ls`.
Any microVM left by the previous controller is removed and its sandbox record becomes `failed` because the foreground CodexPro session belonged to that controller.
The user must destroy the failed sandbox before creating a replacement; chat2shell does not restart CodexPro or recover the old runtime automatically.

## Deferred boundaries

- OAuth principal identity and per-user authorization
- A human approval and monitoring dashboard
- Reboot service installation
- Export automation for private clone changes
- Central Docker Sandbox governance profiles

These additions do not require changing the tunnel endpoint, stable IDs, workspace modes, or public tool names.
