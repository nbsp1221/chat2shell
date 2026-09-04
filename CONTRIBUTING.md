# Contributing to chat2shell

Thanks for taking the time to contribute.

chat2shell is intentionally small and security-sensitive. Prefer focused changes that solve a concrete problem without expanding the execution boundary unnecessarily.

## Before you start

- Use the bug report template for reproducible defects.
- Use the feature request template to explain the problem before proposing a large new capability.
- For substantial behavior or security-boundary changes, open an issue first so the design can be discussed before implementation.
- Do not report security vulnerabilities in public issues. See [SECURITY.md](./SECURITY.md).
- Follow the project [Code of Conduct](./CODE_OF_CONDUCT.md) when participating.

## Development setup

Requirements:

- Node.js 24+
- pnpm 11.23.0
- Docker Sandboxes (`sbx`) only when running real E2E tests

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run the normal quality gate:

```bash
pnpm check
```

`pnpm check` verifies formatting, linting, TypeScript, unit/integration tests, and the production bundle.

## Tests

The test suite is intentionally separated by boundary:

- `pnpm test:unit` — small code units with no external resources
- `pnpm test:integration` — multiple chat2shell components using local resources only
- `pnpm test:e2e` — real Docker Sandbox microVMs, CodexPro, private Docker, and port exposure

Normal CI runs unit and integration tests. Run E2E tests on a trusted host when changing sandbox lifecycle, workspace modes, CodexPro routing, Bash sessions, or port exposure.

See [test/README.md](./test/README.md) for the canonical test taxonomy.

## Pull requests

Keep pull requests small enough to review as one coherent change.

A good pull request should:

1. Explain the user or maintainer problem being solved.
2. Avoid unrelated refactors.
3. Add or update tests for behavior changes.
4. Keep README/architecture/security documentation in sync when public behavior or trust boundaries change.
5. Pass `pnpm check` before submission.

The repository uses Gitmoji-style subjects in its history. Keep titles concise and describe the aggregate change; maintainers may squash commits when merging.

## Documentation ownership

Avoid duplicating system invariants across documents:

- `README.md` is the user-facing landing page and quick start.
- `docs/architecture.md` is the canonical technical description of trust boundaries and runtime behavior.
- `SECURITY.md` defines vulnerability-reporting guidance and security scope.
- `test/README.md` defines test boundaries.
- `ROADMAP.md` contains future product direction, not current guarantees.

## Scope discipline

chat2shell deliberately does not try to be a general-purpose orchestrator. New abstractions, background services, persistence layers, or policy systems should have a demonstrated need before they are added.
