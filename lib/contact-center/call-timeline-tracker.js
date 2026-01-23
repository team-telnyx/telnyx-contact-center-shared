/**
 * Call Timeline Tracker
 * Tracks call lifecycle events for timeline visualization
 */

/**
 * Add a timeline event to routing_metadata
 * @param {Object} currentRoutingMetadata - Current routing_metadata object (or null)
 * @param {string} eventType - Type of event (e.g., 'initiated', 'enqueued', 'offered', 'answered', 'hold', 'resume', 'transfer', 'disconnected')
 * @param {Object} eventData - Additional event data
 * @returns {Object} Updated routing_metadata with timeline event added
 */
export function addTimelineEvent(
  currentRoutingMetadata,
  eventType,
  eventData = {}
) {
  const routingMetadata = currentRoutingMetadata || {};

  // Preserve existing routing information
  const routingInfo = {
    strategy: routingMetadata.strategy,
    algorithm: routingMetadata.algorithm,
    skillMatch: routingMetadata.skillMatch,
    priorityScore: routingMetadata.priorityScore,
    timestamp: routingMetadata.timestamp,
    required_skills: routingMetadata.required_skills,
    priority: routingMetadata.priority,
  };

  // Initialize timeline array if it doesn't exist
  if (!routingMetadata.timeline) {
    routingMetadata.timeline = [];
  }

  // Add new event
  // Preserve timestamp from eventData if provided (for client-side events like hold/resume)
  // Otherwise use current server time
  const { timestamp: providedTimestamp, ...restEventData } = eventData;
  const event = {
    type: eventType,
    timestamp: providedTimestamp || new Date().toISOString(),
    ...restEventData,
  };

  routingMetadata.timeline.push(event);

  // Merge routing info back
  return {
    ...routingInfo,
    ...routingMetadata,
    timeline: routingMetadata.timeline,
  };
}

/**
 * Get timeline events from routing_metadata
 * @param {Object} routingMetadata - routing_metadata object
 * @returns {Array} Array of timeline events
 */
export function getTimelineEvents(routingMetadata) {
  if (!routingMetadata || !routingMetadata.timeline) {
    return [];
  }
  return routingMetadata.timeline;
}

/**
 * Event type constants
 */
export const TimelineEventTypes = {
  INITIATED: "initiated",
  ENQUEUED: "enqueued",
  OFFERED: "offered",
  ALERTING: "alerting",
  ANSWERED: "answered",
  CONNECTED: "connected",
  HOLD: "hold",
  RESUME: "resume",
  TRANSFER: "transfer",
  DISCONNECTED: "disconnected",
  ABANDONED: "abandoned",
  BRIDGED: "bridged",
  WRAPUP_START: "wrapup_start",
  WRAPUP_END: "wrapup_end",
};
