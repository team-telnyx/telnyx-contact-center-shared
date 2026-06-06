export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export async function GET(request) {
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

  // CSV template with headers and one sample record
  const csvTemplate = `first_name,last_name,display_name,company_name,job_title,department,phone,mobile,business_phone_1,business_phone_2,home_phone_1,home_phone_2,email_address_1,email_address_2,address_street,address_city,address_state,address_zip,address_country,notes
John,Doe,John Doe,Acme Corp,Software Engineer,Engineering,+13125551234,+13125551235,+13125551236,+13125551237,+13125551238,+13125551239,john.doe@example.com,john.doe.personal@example.com,123 Main St,New York,NY,10001,US,Sample contact record`;

  return new NextResponse(csvTemplate, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="contacts-template.csv"',
    },
  });
}
