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
    | validated workspace + pinned template + port mapping
    v
Primary execution boundary: Docker Sandbox microVM
    | full shell, workspace access, private Docker Engine
    v
Internal adapter: CodexPro
```

The Secure MCP Tunnel transports MCP messages to one loopback endpoint and does not decide tool policy.
The chat2shell process owns identity, path approval, lifecycle, expiration, and routing.
The `SbxDriver` is the only component allowed to invoke `sbx`, and it accepts structured values rather than raw arguments.

## Runtime ownership

The npm package exposes one `chat2shell` executable. `chat2shell serve` is the only server entry point and stays in the foreground. It validates local dependencies, reconciles persisted sandbox state, opens the loopback MCP gateway, starts tunnel-client as its child, and closes both on SIGINT or SIGTERM.

There is no shell-script supervisor, fixed startup timeout, daemon mode, automatic restart, or service installation. A process manager may supervise `chat2shell serve`, but those policies remain outside the product. `chat2shell status` reads the runtime PID and probes both the MCP gateway and tunnel readiness endpoints.

## Port exposure

`sandbox_expose` asks `SbxDriver` to publish one TCP/IPv4 sandbox port on `0.0.0.0` using an automatically assigned host port. The service inside the sandbox must listen on `0.0.0.0`; chat2shell does not start it or check its protocol or health.

The mapping is owned by Docker Sandboxes and disappears with the sandbox. chat2shell stores no exposure state, creates no URL, adds no authentication or expiration, and has no knowledge of Tailscale or any other route by which the user reaches the host. A repeated request for the same sandbox port returns the existing mapping. Traffic through the mapping does not renew the sandbox inactivity deadline because it is not an MCP tool call.

## Independent identities

`sandbox_id` identifies a disposable microVM and is required on every CodexPro tool call.
`workspace_id` identifies persistent files and can be attached to a replacement sandbox after the previous runtime expires.
Neither identity depends on a ChatGPT conversation or MCP session, so another conversation under the same authenticated principal can discover it with `sandbox_list` or `workspace_list`.

The current authentication provider maps every accepted MCP request to `local-owner`. Secure MCP Tunnel is the recommended transport, but transport and access control remain outside this provider.

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
4. Create a named `shell` microVM from the pinned CodexPro template with Docker Sandboxes resource defaults and one dynamic loopback port.
5. Generate a random CodexPro bearer token.
6. Start CodexPro inside the microVM with full bash, workspace writes, and only the sandbox workspace as an allowed root.
7. Verify its authenticated health endpoint and persist the endpoint and token in the mode-`0600` SQLite database.
8. Return a safe summary that omits the token, endpoint, runtime name, and runtime path.

Failures remove a partially created runtime and persist a `failed` record for diagnosis.

## CodexPro routing

chat2shell loads a pinned static copy of the supported CodexPro tool descriptors; it does not import, start, or inspect CodexPro on the host.
It adds a required `sandbox_id` to every schema. Ordinary tool calls retain their CodexPro contract; Bash replaces CodexPro's request-bound timeout with the explicit execution-session contract below.

For each call, chat2shell validates ownership, expiration, and CodexPro health, removes the outer `sandbox_id`, and forwards the call through an authenticated MCP session to CodexPro inside that microVM.
Calls are serialized per sandbox to prevent concurrent conversations from racing on session selection or writes.

CodexPro assigns its own path-derived workspace ID inside the microVM. That internal ID is not part of the chat2shell contract, so chat2shell replaces it in tool results with the persistent public `workspace_id` associated with the sandbox.

## Bash execution sessions

CodexPro remains the only Bash executor. chat2shell starts each command through CodexPro as a detached process group inside the selected microVM, with combined stdout/stderr written to that microVM's `/tmp` directory.

`bash` always returns a random `session_id` and waits for completion for 10 seconds by default. `yield_time_ms` can explicitly change that wait from 0 to 60 seconds. If the command exits, the call returns `status: exited`, its output, and its exit code; otherwise it returns the output so far and `status: running`. Once the detached launch has succeeded, chat2shell keeps the session handle even if the first status/output snapshot fails. In that case `bash` conservatively returns `status: running`, empty output, and the same `session_id`; a later `bash_poll` recovers the actual state and unread output. This wait controls only when MCP yields a response and never kills the command.

There is no command lifetime limit unless `timeout_ms` is explicitly supplied. `bash_poll` waits until new output appears, the process exits, or its `yield_time_ms` expires. Its wait defaults to 10 seconds and accepts at most 60 seconds. It returns only output not returned by earlier calls and reports the current status and exit code. Polls for one session are serialized. Each response reads at most 60,000 new bytes, preserves complete UTF-8 characters across reads, and reports `has_more_output` when already-buffered output remains. Call it again while `status` is `running` or `has_more_output` is true. `bash_stop` terminates the process group with SIGTERM and escalates to SIGKILL after 1.5 seconds.

Output bytes are transferred through CodexPro as Base64 so its request-level text transformation cannot corrupt or selectively hide streamed content. chat2shell decodes the bytes but does not redact them. Everything printed inside the sandbox is visible to the MCP client; sensitive data is controlled by the files and credentials explicitly made available at the sandbox boundary.

Session metadata lives only in the chat2shell process and session files live only in the microVM. Sandbox deletion removes the processes and files and forgets their IDs. Controller restart does not recover sessions because existing sandboxes are already invalidated by the restart policy. There is no queue, scheduler, retry, automatic restart, or persistent job history.

## Expiration and failure

The lifecycle policy has four rules: a sandbox is removed after 24 hours without a tool call; an active sandbox has no maximum lifetime; a managed workspace is retained for 30 days after sandbox removal; and an expired managed workspace is moved into chat2shell's recoverable trash directory.
Every tool call that reaches a running sandbox renews its idle deadline, whether the call succeeds or fails.
The trash directory is not emptied automatically. Host workspaces are never moved or deleted because chat2shell does not own them.

At controller startup, persisted active records are reconciled with `sbx ls`.
Any microVM left by the previous controller is removed and its sandbox record becomes `failed` because the foreground CodexPro session belonged to that controller.
The user must destroy the failed sandbox before creating a replacement; chat2shell does not restart CodexPro or recover the old runtime automatically.
Reconciliation completes before the MCP gateway begins listening and has no chat2shell-imposed time limit.
