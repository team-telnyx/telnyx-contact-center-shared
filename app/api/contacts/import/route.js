export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";

// Expected CSV headers (same as validation)
const REQUIRED_HEADERS = [
  "first_name",
  "last_name",
  "display_name",
  "company_name",
  "job_title",
  "department",
  "phone",
  "mobile",
  "business_phone_1",
  "business_phone_2",
  "home_phone_1",
  "home_phone_2",
  "email_address_1",
  "email_address_2",
  "address_street",
  "address_city",
  "address_state",
  "address_zip",
  "address_country",
  "notes",
];

function parseCSV(text) {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    rows.push(row);
  }

  return { headers, rows };
}

function validateRow(row) {
  // At least one of first_name, last_name, display_name, or company_name must be present
  if (
    !row.first_name &&
    !row.last_name &&
    !row.display_name &&
    !row.company_name
  ) {
    return false;
  }
  return true;
}

export async function POST(request) {
  // Check admin authentication
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pool = getPostgresPool();
  if (!pool) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows } = parseCSV(text);

    // Validate headers
    const headerSet = new Set(headers);
    for (const required of REQUIRED_HEADERS) {
      if (!headerSet.has(required)) {
        return NextResponse.json(
          { error: `Missing required column: ${required}` },
          { status: 400 }
        );
      }
    }

    // Process and import valid rows
    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;
    const errors = [];

    // Import in batches for better performance
    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const validRows = [];

      // Filter and prepare valid rows
      for (const row of batch) {
        if (!validateRow(row)) {
          skipped++;
          continue;
        }
        validRows.push(row);
      }

      if (validRows.length === 0) continue;

      // Build batch insert
      const values = [];
      const placeholders = [];
      let paramIndex = 1;

      for (const row of validRows) {
        const contactId = randomUUID();
        const ph = [];

        values.push(
          contactId,
          row.first_name || null,
          row.last_name || null,
          row.display_name || null,
          row.company_name || null,
          row.job_title || null,
          row.department || null,
          row.phone || null,
          row.mobile || null,
          row.business_phone_1 || null,
          row.business_phone_2 || null,
          row.home_phone_1 || null,
          row.home_phone_2 || null,
          row.email_address_1 || null,
          row.email_address_2 || null,
          row.address_street || null,
          row.address_city || null,
          row.address_state || null,
          row.address_zip || null,
          row.address_country || null,
          row.notes || null,
          user.id, // created_by
          now,
          now
        );

        for (let k = 0; k < 24; k++) {
          ph.push(`$${paramIndex++}`);
        }
        placeholders.push(`(${ph.join(", ")})`);
      }

      if (values.length > 0) {
        try {
          const query = `
            INSERT INTO contacts (
              id, first_name, last_name, display_name, company_name, job_title, department,
              phone, mobile, business_phone_1, business_phone_2, home_phone_1, home_phone_2,
              email_address_1, email_address_2,
              address_street, address_city, address_state, address_zip, address_country,
              notes, created_by, created_at, updated_at
            ) VALUES ${placeholders.join(", ")}
          `;

          await pool.query(query, values);
          imported += validRows.length;
        } catch (err) {
          errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${err.message}`);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      imported,
      skipped,
      total: rows.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Import error" },
      { status: 400 }
    );
  }
}
