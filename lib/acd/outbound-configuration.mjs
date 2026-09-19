// A configured but missing/inactive restriction must never silently disappear
// from a Core campaign. Historical legacy executors remain isolated.
export async function unavailableOutboundResource(tx,campaign) {
  const metadata=campaign.metadata || {};
  const resources=[
    ['outbound_contact_filters',metadata.contact_list_filter_id || metadata.filter_id],
    ['outbound_time_sets',metadata.contactable_time_set_id || metadata.time_set_id],
    ['outbound_dnc_lists',metadata.dnc_list_id],
    ['outbound_attempt_controls',campaign.attempt_control_id],
  ];
  for(const [table,id] of resources) {
    if(!id) continue;
    const active=await tx.query(`SELECT 1 FROM ${table} WHERE id=$1 AND status='active'`,[id]);
    if(!active.rowCount) return table;
  }
  return null;
}
