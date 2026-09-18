// Provider chain for messaging campaign sends started from the web process
// (test messages, manual ticks). The worker uses the same decorators around
// the Telnyx voice provider; here the innermost provider only rejects
// operations no messaging decorator handles.
import { emailProvider } from "../../email/provider.mjs";
import { smsProvider } from "../../sms/provider.mjs";
import { whatsappProvider } from "../../whatsapp/provider.mjs";

const unsupported = {
  name: "messaging-only",
  async send(command) {
    return { outcome: "failed", httpStatus: 501, response: { error: `Unsupported operation ${command?.operation || "unknown"}` } };
  },
};

export function messagingProvider(inner = unsupported) {
  return whatsappProvider(smsProvider(emailProvider(inner)));
}
