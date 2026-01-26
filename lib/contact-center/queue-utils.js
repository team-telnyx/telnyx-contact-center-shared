import { PgDb } from "@/lib/pgdb";

const SHARED_QUEUES = ["SALES", "SUPPORT", "MARKETING"];

/**
 * Resolve queue name to determine if it's shared or private
 * @param {string} queueName - Queue name from Telnyx (case-sensitive)
 * @param {string} username - Username for private queue resolution
 * @returns {Object} { type: 'shared'|'private', name: string, owner?: string }
 */
export function resolveQueueName(queueName, username) {
  const upperQueueName = queueName.toUpperCase();

  if (SHARED_QUEUES.includes(upperQueueName)) {
    return { type: "shared", name: upperQueueName };
  } else {
    // Private queue - derive from username
    const privateQueueName = username
      ? username.split("@")[0].toUpperCase()
      : upperQueueName;
    return { type: "private", name: privateQueueName, owner: username };
  }
}

/**
 * Check if a queue name is a contact center queue
 * @param {string} queueName - Queue name to check
 * @returns {boolean}
 */
export function isContactCenterQueue(queueName) {
  if (!queueName) return false;
  const upperQueueName = queueName.toUpperCase();
  return SHARED_QUEUES.includes(upperQueueName) || upperQueueName.length > 0;
}

/**
 * Find a queue record (queues should only be created in Admin - Queues screen)
 * @param {string} queueName - Queue name
 * @param {string} username - Username (for private queues)
 * @returns {Promise<Object|null>} Queue record or null if not found
 */
export async function getOrCreateQueue(queueName, username = null) {
  const resolved = resolveQueueName(queueName, username);

  // Only find existing queues - never create them dynamically
  // Queues must be created in Admin - Queues screen
  const queue = await PgDb.findQueueByName(resolved.name);

  if (!queue) {
    return null;
  }

  return queue;
}

/**
 * Initialize shared queues (SALES, SUPPORT, MARKETING)
 * @returns {Promise<void>}
 */
export async function initializeSharedQueues() {
  for (const queueName of SHARED_QUEUES) {
    await getOrCreateQueue(queueName);
  }
}

/**
 * Get private queue name for a user
 * @param {string} username - Username
 * @returns {string} Private queue name (uppercase)
 */
export function getPrivateQueueName(username) {
  if (!username) return null;
  return username.split("@")[0].toUpperCase();
}
