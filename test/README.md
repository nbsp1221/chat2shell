# Tests

The test suite is split by the boundary each test crosses. Keep tests in the narrowest category that still exercises the behavior realistically.

## Unit

`test/unit` covers small code units without external resources or cross-component runtime behavior.

```bash
pnpm test:unit
```

Examples include configuration parsing, CLI behavior, tool schema transformation, and result normalization.

## Integration

`test/integration` connects multiple chat2shell components and may use local process resources such as temporary files, SQLite, or loopback HTTP. It must not require Docker Sandboxes (`sbx`) or a real CodexPro microVM.

```bash
pnpm test:integration
```

The default test command runs unit and integration tests only:

```bash
pnpm test
```

This is the test boundary used by normal GitHub CI.

## E2E

`test/e2e` exercises the public MCP boundary against real Docker Sandbox microVMs, CodexPro, the sandbox-private Docker Engine, and host port exposure.

```bash
pnpm test:e2e
```

E2E tests require a trusted chat2shell host with the `sbx` executable and the `chat2shell-codexpro:0.30.0` template installed. The command fails when those prerequisites are unavailable; it does not silently skip the suite.

Real E2E tests do not run on ordinary GitHub-hosted CI. Run them on a trusted development host before changes that affect the sandbox boundary, lifecycle, workspace modes, CodexPro routing, or port exposure.

## Coverage

Coverage uses Vitest's V8 provider for unit and integration tests:

```bash
pnpm test:coverage
```

Coverage is diagnostic rather than a percentage gate. Security and lifecycle invariants are more important than maximizing line coverage.
