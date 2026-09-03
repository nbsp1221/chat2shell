import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import standardTools from './standard-tools.json' with { type: 'json' };

export function codexProToolManifest(): readonly Tool[] {
  return standardTools as unknown as readonly Tool[];
}

export function scopedCodexProTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties ?? {};
  if ('sandbox_id' in properties) {
    throw new Error(`CodexPro tool conflicts with the chat2shell routing field: ${tool.name}`);
  }
  return {
    ...tool,
    description: `${tool.description ?? tool.name} Runs only inside the selected chat2shell sandbox.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        sandbox_id: {
          type: 'string',
          description: 'Sandbox id from sandbox_create or sandbox_list.',
        },
        ...properties,
      },
      required: [...new Set(['sandbox_id', ...(tool.inputSchema.required ?? [])])],
      additionalProperties: false,
    },
  };
}
