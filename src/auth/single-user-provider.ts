import type { AuthProvider, Principal } from "./provider.js";

const localPrincipal: Principal = {
  id: "local-owner",
  authenticationMethod: "single-user",
};

export class SingleUserAuthProvider implements AuthProvider {
  async authenticate(): Promise<Principal> {
    return localPrincipal;
  }
}
