import { checkPhoneSipRegistrationStatus } from "./credentials.mjs";

function connectionIdForPhone(phone = {}) {
  return phone.telnyx_connection_id || phone.telnyx_credential_id || null;
}

function shouldRefreshRegistration(phone = {}, now = Date.now()) {
  const status = String(phone.sip_registration_status || "").trim().toLowerCase();
  if (!status || status === "unknown") return true;
  const updatedAt = phone.sip_registration_status_at ? Date.parse(phone.sip_registration_status_at) : 0;
  if (!updatedAt) return true;
  return now - updatedAt > 120_000;
}

export async function syncHardphoneRegistrationStatusesFromTelnyx(pool, phones = [], { max = 25 } = {}) {
  if (!pool || !Array.isArray(phones) || !phones.length) return phones;
  const now = Date.now();
  const nextPhones = [...phones];
  const candidates = phones
    .map((phone, index) => ({ phone, index, connectionId: connectionIdForPhone(phone) }))
    .filter(({ phone, connectionId }) => connectionId && shouldRefreshRegistration(phone, now))
    .slice(0, max);

  await Promise.all(candidates.map(async ({ phone, index, connectionId }) => {
    const status = await checkPhoneSipRegistrationStatus(connectionId).catch(() => null);
    const registrationStatus = status?.registration_status || null;
    if (!registrationStatus) return;
    const statusAt = status.last_registration ? new Date(status.last_registration).toISOString() : new Date().toISOString();
    await pool.query(
      `UPDATE hp_phones
       SET sip_registration_status = $2,
           sip_registration_status_at = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [phone.id, registrationStatus, statusAt],
    );
    nextPhones[index] = {
      ...phone,
      sip_registration_status: registrationStatus,
      sip_registration_status_at: statusAt,
    };
  }));

  return nextPhones;
}
