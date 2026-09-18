import { emailError } from '../email/provider.mjs';

// Keep explicit responses for clients that still have the retired composer open.
export async function emailComposeMailboxes() { return []; }
export async function createOutboundEmail() {
  throw emailError('Agents can only reply to or forward incoming email',403);
}

export { transferEmailWork } from './text-transfer.mjs';
