import type { IncomingHttpHeaders } from "node:http";

export interface Principal {
  readonly id: string;
  readonly authenticationMethod: "single-user" | "oauth";
}

export interface AuthProvider {
  authenticate(headers: IncomingHttpHeaders): Promise<Principal>;
}
