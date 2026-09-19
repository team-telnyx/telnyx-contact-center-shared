const PHONE_COLUMNS = [
  "phone",
  "mobile",
  "business_phone_1",
  "business_phone_2",
  "home_phone_1",
  "home_phone_2",
];

export function normalizeCallerPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

export function callerNameFromRecord(record = {}) {
  const directName = [record.display_name, record.full_name].find((value) =>
    String(value || "").trim(),
  );
  if (directName) return String(directName).trim();

  const composed = [record.first_name, record.last_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  return composed || null;
}

function matchRequestedPhone(matchedPhone, requested) {
  if (requested.includes(matchedPhone)) return matchedPhone;
  if (matchedPhone.length < 9) return null;
  const suffix = matchedPhone.slice(-9);
  return (
    requested.find(
      (number) => number.length >= 9 && number.slice(-9) === suffix,
    ) || null
  );
}

/**
 * Resolve phone numbers only against the Contact Center `contacts` table.
 * Every supported contact phone field is checked. Exact normalized matches
 * win, with the last nine digits used only to bridge local/E.164 formatting.
 */
export async function resolveCallerIdentities(db, phoneNumbers = []) {
  const requested = [
    ...new Set(phoneNumbers.map(normalizeCallerPhone).filter(Boolean)),
  ];
  const resolved = new Map();
  if (!db || requested.length === 0) return resolved;

  const suffixes = requested.map((number) =>
    number.length >= 9 ? number.slice(-9) : "",
  );
  const phoneExpressions = PHONE_COLUMNS.map(
    (column) =>
      `regexp_replace(COALESCE(t.${column}::text, ''), '[^0-9]', '', 'g')`,
  );
  let result;
  try {
    result = await db.query(
      `SELECT to_jsonb(t) AS record, matched.normalized_phone
       FROM contacts t
       CROSS JOIN LATERAL (
         SELECT normalized_phone
           FROM unnest(ARRAY[${phoneExpressions.join(", ")}]) AS candidate(normalized_phone)
          WHERE normalized_phone <> ''
            AND (
              normalized_phone = ANY($1::text[])
              OR (
                length(normalized_phone) >= 9
                AND right(normalized_phone, 9) = ANY($2::text[])
              )
            )
          ORDER BY CASE WHEN normalized_phone = ANY($1::text[]) THEN 0 ELSE 1 END
          LIMIT 1
       ) matched
      WHERE t.deleted_at IS NULL
      ORDER BY t.last_interaction_at DESC NULLS LAST, t.created_at DESC`,
      [requested, suffixes],
    );
  } catch {
    // Caller enrichment is optional and must never block routing or history.
    return resolved;
  }

  for (const row of result.rows) {
    const name = callerNameFromRecord(row.record);
    const requestedPhone = matchRequestedPhone(
      row.normalized_phone,
      requested,
    );
    if (!name || !requestedPhone || resolved.has(requestedPhone)) continue;
    resolved.set(requestedPhone, {
      name,
      id: row.record.id || row.record.contact_id || null,
      source: "contacts",
      table: "contacts",
    });
  }

  return resolved;
}

export async function resolveCallerIdentity(db, phoneNumber) {
  const normalized = normalizeCallerPhone(phoneNumber);
  if (!normalized) return null;
  const resolved = await resolveCallerIdentities(db, [normalized]);
  return resolved.get(normalized) || null;
}
