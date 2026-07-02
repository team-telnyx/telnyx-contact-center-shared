import { notFound } from "next/navigation";
import { FormEditor } from "@/components/forms/FormEditor";
import { createDefaultForm } from "@/lib/forms/form-schema";
import { getPostgresPool } from "@/lib/postgres.mjs";

function serializeForm(row) {
  if (!row) return null;
  return {
    ...row,
    queue_ids: row.queue_ids || [],
    queue_names: row.queue_names || [],
    created_at: row.created_at?.toISOString?.() || row.created_at || null,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at || null,
    published_at: row.published_at?.toISOString?.() || row.published_at || null,
  };
}

async function getForm(id) {
  if (id === "new") return createDefaultForm({ name: "New agent form" });
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE id = $1`, [id]);
  return serializeForm(rows[0]);
}

export default async function AdminFormEditorPage({ params }) {
  const { id } = await params;
  const form = await getForm(id);
  if (!form) notFound();
  return <FormEditor initialForm={form} isNew={id === "new"} />;
}
