import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import standardTools from './standard-tools.json' with { type: 'json' };

const bashOutputSchema = {
  type: 'object' as const,
  properties: {
    session_id: { type: 'string' as const, description: 'Execution session id returned by bash.' },
    status: {
      type: 'string' as const,
      enum: ['running', 'exited'],
      description: 'Whether the process is still running or has exited.',
    },
    exit_code: {
      anyOf: [{ type: 'integer' as const }, { type: 'null' as const }],
      description: 'Process exit code after exit, otherwise null.',
    },
    output: {
      type: 'string' as const,
      description: 'New combined stdout/stderr not returned by an earlier response.',
    },
    has_more_output: {
      type: 'boolean' as const,
      description:
        'Whether more already-buffered output remains. A running process may produce future output even when this is false.',
    },
  },
  required: ['session_id', 'status', 'exit_code', 'output', 'has_more_output'],
  additionalProperties: false,
};

const bashPollTool: Tool = {
  name: 'bash_poll',
  title: 'Poll Bash Session',
  description:
    'Wait for new output, process exit, or yield expiry, then return only new combined stdout/stderr and current status. Poll again while status is running or has_more_output is true.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox_id: { type: 'string', description: 'Sandbox id used to start the Bash session.' },
      session_id: { type: 'string', description: 'Session id returned by bash.' },
      yield_time_ms: {
        type: 'integer',
        minimum: 0,
        maximum: 60_000,
        default: 10_000,
        description: 'Maximum time to wait for new output or exit.',
      },
    },
    required: ['sandbox_id', 'session_id'],
    additionalProperties: false,
  },
  outputSchema: bashOutputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const bashStopTool: Tool = {
  name: 'bash_stop',
  title: 'Stop Bash Session',
  description:
    'Stop a running Bash session with SIGTERM, followed by SIGKILL after 1.5 seconds if it has not exited.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox_id: { type: 'string', description: 'Sandbox id used to start the Bash session.' },
      session_id: { type: 'string', description: 'Session id returned by bash.' },
    },
    required: ['sandbox_id', 'session_id'],
    additionalProperties: false,
  },
  outputSchema: bashOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
};

export function codexProToolManifest(): readonly Tool[] {
  return standardTools as unknown as readonly Tool[];
}

export function scopedCodexProTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties ?? {};
  if ('sandbox_id' in properties) {
    throw new Error(`CodexPro tool conflicts with the chat2shell routing field: ${tool.name}`);
  }
  const scoped: Tool = {
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
  if (tool.name !== 'bash') {
    return scoped;
  }
  const {
    session_id: _sessionId,
    timeout_ms: _timeoutMs,
    ...bashProperties
  } = scoped.inputSchema.properties as Record<string, unknown>;
  return {
    ...scoped,
    description:
      'Run unrestricted Bash inside the selected sandbox and return an execution session. Poll it with bash_poll while status is running or has_more_output is true, or terminate it with bash_stop. There is no execution timeout unless timeout_ms is explicitly provided. The command cannot access the host shell or host Docker daemon.',
    inputSchema: {
      ...scoped.inputSchema,
      properties: {
        ...bashProperties,
        yield_time_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 60_000,
          default: 10_000,
          description: 'How long to wait for completion before returning a running session.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1_000,
          description:
            'Optional execution time limit. Without this argument the process has no time limit.',
        },
      },
    },
    outputSchema: bashOutputSchema,
  };
}

export function publicCodexProTools(): readonly Tool[] {
  return [...codexProToolManifest().map(scopedCodexProTool), bashPollTool, bashStopTool];
}
