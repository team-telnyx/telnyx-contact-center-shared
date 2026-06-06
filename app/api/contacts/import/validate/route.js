import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export const dynamic = "force-dynamic";

// Expected CSV headers
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

function validateHeaders(headers) {
  const errors = [];
  const headerSet = new Set(headers);

  for (const required of REQUIRED_HEADERS) {
    if (!headerSet.has(required)) {
      errors.push(`Missing required column: ${required}`);
    }
  }

  return errors;
}

function validateRow(row, rowIndex) {
  const errors = [];
  const rowNum = rowIndex + 2; // +2 because row 1 is header, and we're 0-indexed

  // At least one of first_name, last_name, display_name, or company_name must be present
  if (
    !row.first_name &&
    !row.last_name &&
    !row.display_name &&
    !row.company_name
  ) {
    errors.push(
      `Row ${rowNum}: At least one of first_name, last_name, display_name, or company_name is required`
    );
  }

  // Validate email format if provided
  if (
    row.email_address_1 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email_address_1)
  ) {
    errors.push(`Row ${rowNum}: Invalid email format in email_address_1`);
  }
  if (
    row.email_address_2 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email_address_2)
  ) {
    errors.push(`Row ${rowNum}: Invalid email format in email_address_2`);
  }

  return errors;
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

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows } = parseCSV(text);

    // Validate headers
    const headerErrors = validateHeaders(headers);
    if (headerErrors.length > 0) {
      return NextResponse.json(
        { error: "Invalid CSV format", errors: headerErrors },
        { status: 400 }
      );
    }

    // Validate rows
    const allErrors = [];
    let validRowCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowErrors = validateRow(rows[i], i);
      if (rowErrors.length > 0) {
        allErrors.push(...rowErrors);
      } else {
        validRowCount++;
      }
    }

    if (allErrors.length > 0) {
      return NextResponse.json(
        {
          error: "Validation failed",
          errors: allErrors,
          recordCount: validRowCount,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      recordCount: validRowCount,
      totalRows: rows.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Validation error" },
      { status: 400 }
    );
  }
}
