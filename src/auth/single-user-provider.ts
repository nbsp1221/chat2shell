import type { AuthProvider, Principal } from './provider.js';

const localPrincipal: Principal = {
  id: 'local-owner',
  authenticationMethod: 'single-user',
};

export class SingleUserAuthProvider implements AuthProvider {
  authenticate(): Promise<Principal> {
    return Promise.resolve(localPrincipal);
  }
}
