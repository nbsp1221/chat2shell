import { expect, test } from 'vitest';
import {
  codexProToolManifest,
  publicCodexProTools,
  scopedCodexProTool,
} from '../../src/codexpro/tool-manifest.js';

test('every CodexPro tool schema is static and scoped by an explicit sandbox_id', () => {
  const tools = codexProToolManifest();

  expect(tools.length).toBeGreaterThan(10);
  for (const rawTool of tools) {
    expect(rawTool.inputSchema.properties?.workspace_id, rawTool.name).toBeUndefined();
    const tool = scopedCodexProTool(rawTool);
    expect(tool.inputSchema.required, tool.name).toContain('sandbox_id');
    expect(tool.inputSchema.properties?.sandbox_id, tool.name).toMatchObject({ type: 'string' });
  }
  expect(tools.some((tool) => tool.name === 'open_workspace')).toBe(false);
  expect(tools.find((tool) => tool.name === 'bash')?.description ?? '').toMatch(
    /unrestricted Bash/,
  );
});

test('the public Bash contract uses explicit long-running sessions', () => {
  const tools = publicCodexProTools();
  const bash = tools.find((tool) => tool.name === 'bash');
  const poll = tools.find((tool) => tool.name === 'bash_poll');
  const stop = tools.find((tool) => tool.name === 'bash_stop');

  expect(tools).toHaveLength(codexProToolManifest().length + 2);
  expect(bash?.inputSchema.properties?.session_id).toBeUndefined();
  expect(bash?.inputSchema.properties?.yield_time_ms).toMatchObject({
    default: 10_000,
    maximum: 60_000,
  });
  expect(bash?.inputSchema.properties?.timeout_ms).not.toHaveProperty('maximum');
  expect(poll?.inputSchema.properties?.yield_time_ms).toMatchObject({
    default: 10_000,
    maximum: 60_000,
  });
  expect(poll?.outputSchema).toEqual(bash?.outputSchema);
  expect(stop?.outputSchema).toEqual(bash?.outputSchema);
  expect(bash?.outputSchema?.properties?.status).toMatchObject({ enum: ['running', 'exited'] });
});
