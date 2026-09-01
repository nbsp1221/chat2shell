import { SingleUserAuthProvider } from "../auth/single-user-provider.js";
import { loadGatewayConfig } from "../config.js";
import { createGateway } from "./gateway.js";

const config = loadGatewayConfig();
const server = createGateway(config, { authProvider: new SingleUserAuthProvider() });

server.listen(config.port, config.host, () => {
  console.log(`[chat2shell] listening on http://${config.host}:${config.port}/mcp`);
  console.log(`[chat2shell] upstream ${config.upstreamUrl.href}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
