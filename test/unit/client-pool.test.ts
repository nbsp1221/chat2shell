import { expect, test } from 'vitest';
import { normalizeWorkspaceIdentity } from '../../src/codexpro/client-pool.js';

test("replaces CodexPro's internal workspace identity with the public chat2shell identity", () => {
  const result = normalizeWorkspaceIdentity(
    {
      content: [{ type: 'text', text: 'Workspace ws_internal selected; ws_internal is ready.' }],
      structuredContent: {
        root: '/workspace',
        selected_workspace_id: 'ws_internal',
        workspace_id: 'ws_internal',
      },
    },
    'ws_public',
  );

  expect(result.structuredContent).toEqual({
    root: '/workspace',
    selected_workspace_id: 'ws_public',
    workspace_id: 'ws_public',
  });
  expect(result.content[0]?.type).toBe('text');
  expect(result.content[0]?.type === 'text' ? result.content[0].text : undefined).toBe(
    'Workspace ws_public selected; ws_public is ready.',
  );
});

test('leaves results without a CodexPro workspace identity untouched', () => {
  const result = {
    content: [{ type: 'text' as const, text: 'No workspace identity' }],
    structuredContent: { status: 'ok' },
  };

  expect(normalizeWorkspaceIdentity(result, 'ws_public')).toBe(result);
});
