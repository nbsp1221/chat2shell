# Security policy

chat2shell deliberately gives an AI agent strong capabilities inside disposable Docker Sandbox microVMs. Security reports should distinguish between that intended sandbox authority and ways to cross or bypass the documented boundary.

## Supported versions

Security fixes target the latest published release and the current `main` branch.

| Version                                        | Supported |
| ---------------------------------------------- | --------- |
| Latest published release                       | ✅        |
| Current `main`                                 | ✅        |
| Older releases, forks, or modified deployments | ❌        |

## Reporting a vulnerability

Do **not** disclose suspected vulnerabilities, credentials, tokens, private paths, or exploit details in a public issue.

Use GitHub's private vulnerability reporting for this repository when the **Report a vulnerability** option is available. If private reporting is not available, open a minimal public issue asking the maintainer for a private reporting channel **without including vulnerability details**.

A useful report includes:

- the affected commit or version;
- the security boundary you believe can be crossed;
- minimal reproduction steps;
- the expected and observed behavior;
- impact and any known preconditions.

## In scope

Examples of security issues include:

- escaping a Docker Sandbox to execute commands on the host;
- reaching the host Docker daemon or host shell through an MCP tool;
- accessing a host path that was not managed by chat2shell or explicitly approved;
- bypassing sandbox/workspace ownership checks;
- exposing internal CodexPro bearer tokens or tunnel secrets through the public MCP surface;
- unintentionally exposing the MCP server beyond its configured access boundary.

## Expected behavior

The following are intentional capabilities and are not vulnerabilities by themselves:

- unrestricted shell and package installation inside a selected sandbox;
- control of the sandbox's private Docker Engine;
- network access allowed by the underlying Docker Sandboxes policy;
- modification of an explicitly approved `direct` workspace;
- unauthenticated access to a service intentionally published with `sandbox_expose`;
- MCP requests being treated as `local-owner` by the current single-user authentication provider.

The MCP endpoint has no built-in authentication. It binds to loopback by default and should be exposed only through an access-controlled transport such as Secure MCP Tunnel. See [docs/architecture.md](./docs/architecture.md) for the canonical trust model.
