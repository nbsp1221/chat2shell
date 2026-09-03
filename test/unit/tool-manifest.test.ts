import { expect, test } from 'vitest';
import { codexProToolManifest, scopedCodexProTool } from '../../src/codexpro/tool-manifest.js';

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
