/** Runtime transitions belong to the execution API, never to configuration CRUD. */
export const CAMPAIGN_RUNTIME_METADATA = ['execution_control', 'execution_state', 'messaging_runtime', 'event_timeline'];
export function campaignConfigurationError(status, currentStatus = null) {
  if (status === currentStatus) return null;
  if ((!currentStatus || ['draft', 'ready'].includes(currentStatus)) && ['draft', 'ready'].includes(status)) return null;
  return 'Use the campaign execution action to change runtime status';
}
export function configurationMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => !CAMPAIGN_RUNTIME_METADATA.includes(key)));
}
