import {
  getPhoneNumber,
  getPhoneSipConnection,
  hardphoneMacFromSipConnection,
  isHardphoneSipConnection,
  listTelnyxPhoneNumbers,
  updatePhoneSipConnectionCallerId,
} from "./credentials.mjs";

function phoneNumberConnectionId(number = {}) {
  return number?.connection_id || number?.voice?.connection_id || null;
}

async function findHardphoneForConnection(pool, connectionId) {
  if (!pool || !connectionId) return null;
  const { rows } = await pool.query(
    `SELECT id, mac, telnyx_connection_id, telnyx_credential_id FROM hp_phones
     WHERE telnyx_connection_id = $1 OR telnyx_credential_id = $1
     LIMIT 1`,
    [connectionId],
  );
  if (rows.length) return rows[0];

  let connection = null;
  try {
    connection = await getPhoneSipConnection(connectionId);
  } catch {
    return null;
  }
  if (!connection || !isHardphoneSipConnection(connection)) return null;
  const mac = hardphoneMacFromSipConnection(connection);
  if (!mac) return null;
  const byMac = await pool.query(
    `SELECT id, mac, telnyx_connection_id, telnyx_credential_id FROM hp_phones WHERE mac = $1 LIMIT 1`,
    [mac.toLowerCase()],
  );
  return byMac.rows[0] || null;
}

export async function syncHardphonePhoneNumberAssignment(pool, phoneNumberOrId) {
  if (!pool || !phoneNumberOrId) return null;
  const number = typeof phoneNumberOrId === "string" ? await getPhoneNumber(phoneNumberOrId) : phoneNumberOrId;
  if (!number?.id || !number?.phone_number) return null;
  const connectionId = phoneNumberConnectionId(number);
  const numberValue = number.phone_number;

  const currentRows = await pool.query(
    `SELECT id FROM hp_phones
     WHERE assigned_phone_number_id = $1 OR assigned_phone_number = $2`,
    [number.id, numberValue],
  );

  const targetPhone = connectionId ? await findHardphoneForConnection(pool, connectionId) : null;
  const targetPhoneId = targetPhone?.id || null;

  for (const row of currentRows.rows) {
    if (row.id !== targetPhoneId) {
      await pool.query(
        `UPDATE hp_phones
         SET assigned_phone_number_id = NULL, assigned_phone_number = NULL, updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
    }
  }

  if (!targetPhoneId) return null;
  await pool.query(
    `UPDATE hp_phones
     SET assigned_phone_number_id = $2, assigned_phone_number = $3, updated_at = NOW()
     WHERE id = $1`,
    [targetPhoneId, number.id, numberValue],
  );
  try {
    await updatePhoneSipConnectionCallerId({ connectionId, phoneNumber: numberValue });
  } catch {}
  return { phone_id: targetPhoneId, assigned_phone_number_id: number.id, assigned_phone_number: numberValue };
}

export async function syncHardphonePhoneNumbersFromTelnyx(pool, phones = []) {
  if (!pool || !phones.length || !process.env.TELNYX_API_KEY) return [];
  const connectionIds = new Set(phones.map((phone) => phone.telnyx_connection_id || phone.telnyx_credential_id).filter(Boolean));
  if (!connectionIds.size) return phones;
  let numbers = [];
  try {
    numbers = await listTelnyxPhoneNumbers({ limit: 250, pages: 5 });
  } catch {
    return phones;
  }
  const byConnection = new Map();
  for (const number of numbers) {
    const connectionId = phoneNumberConnectionId(number);
    if (connectionId && connectionIds.has(connectionId)) byConnection.set(connectionId, number);
  }
  const nextPhones = [];
  for (const phone of phones) {
    const connectionId = phone.telnyx_connection_id || phone.telnyx_credential_id || null;
    const number = connectionId ? byConnection.get(connectionId) : null;
    if (number?.id && (phone.assigned_phone_number_id !== number.id || phone.assigned_phone_number !== number.phone_number)) {
      await pool.query(
        `UPDATE hp_phones
         SET assigned_phone_number_id = $2, assigned_phone_number = $3, updated_at = NOW()
         WHERE id = $1`,
        [phone.id, number.id, number.phone_number],
      );
      nextPhones.push({ ...phone, assigned_phone_number_id: number.id, assigned_phone_number: number.phone_number });
    } else if (!number && (phone.assigned_phone_number_id || phone.assigned_phone_number)) {
      await pool.query(
        `UPDATE hp_phones
         SET assigned_phone_number_id = NULL, assigned_phone_number = NULL, updated_at = NOW()
         WHERE id = $1`,
        [phone.id],
      );
      nextPhones.push({ ...phone, assigned_phone_number_id: null, assigned_phone_number: null });
    } else {
      nextPhones.push(phone);
    }
  }
  return nextPhones;
}
