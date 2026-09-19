// Contacts are shared in CC. This projection deliberately excludes notes,
// addresses, custom fields, users and assistants from the agent email picker.
export async function searchEmailRecipients(db,{query='',page=1,pageSize=20}={}) {
  const q=String(query||'').trim().slice(0,120).replace(/[\\%_]/g,'\\$&');
  page=Math.min(10000,Math.max(1,parseInt(page,10)||1));
  pageSize=Math.min(50,Math.max(1,parseInt(pageSize,10)||20));
  const result=await db.query(`WITH addresses AS (
    SELECT c.id AS contact_id,
      COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),lower(trim(e.address))) AS name,
      c.company_name AS company,lower(trim(e.address)) AS email,min(e.position) AS position
    FROM contacts c CROSS JOIN LATERAL (VALUES(c.email_address_1,1),(c.email_address_2,2)) e(address,position)
    WHERE c.deleted_at IS NULL AND length(trim(e.address))<=254
      AND trim(e.address) ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+\\.[^[:space:]<>@,;]+$'
      AND ($1='' OR concat_ws(' ',c.display_name,c.first_name,c.last_name,c.company_name,c.email_address_1,c.email_address_2) ILIKE '%'||$1||'%')
    GROUP BY c.id,c.display_name,c.first_name,c.last_name,c.company_name,lower(trim(e.address))
  ) SELECT *,count(*) OVER()::int AS total FROM addresses ORDER BY lower(name),contact_id,position,email LIMIT $2 OFFSET $3`,[q,pageSize,(page-1)*pageSize]);
  return {data:result.rows.map(({total:_total,...row})=>row),total:result.rows[0]?.total||0,page,pageSize};
}
