export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly upstreamUrl: URL;
  readonly maxBodyBytes: number;
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = environment.CHAT2SHELL_HOST ?? "127.0.0.1";
  const port = readPort(environment.CHAT2SHELL_GATEWAY_PORT, 18_788, "CHAT2SHELL_GATEWAY_PORT");
  const upstreamPort = readPort(environment.CHAT2SHELL_CODEXPRO_PORT, 18_787, "CHAT2SHELL_CODEXPRO_PORT");
  const upstreamUrl = new URL(environment.CHAT2SHELL_CODEXPRO_URL ?? `http://${host}:${upstreamPort}/mcp`);
  const maxBodyBytes = Number(environment.CHAT2SHELL_MAX_BODY_BYTES ?? 20 * 1024 * 1024);

  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("CHAT2SHELL_MAX_BODY_BYTES must be a positive integer");
  }

  return { host, port, upstreamUrl, maxBodyBytes };
}
