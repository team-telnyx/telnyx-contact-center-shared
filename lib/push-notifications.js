import { getPostgresPool } from "./postgres.mjs";
import { randomUUID } from "crypto";

/**
 * Add a push token to the database
 * @param {string} username - The username
 * @param {string} provider - The push notification provider (e.g., "expo")
 * @param {string} os - The operating system (e.g., "ios", "android")
 * @param {string} token - The push token
 * @returns {Promise<{success: boolean, message: string, id?: string}>}
 */
export async function addPushToken(username, provider, os, token) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");

  try {
    // Check if token already exists
    const existing = await pool.query(
      `SELECT id FROM push_tokens WHERE username = $1 AND provider = $2 AND os = $3 AND token = $4`,
      [username, provider, os, token]
    );

    if (existing.rows.length > 0) {
      return {
        success: true,
        message: "Push token already registered",
        id: existing.rows[0].id,
      };
    }

    // Insert new token
    const id = randomUUID();
    await pool.query(
      `INSERT INTO push_tokens (id, username, provider, os, token, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [id, username, provider, os, token]
    );

    return {
      success: true,
      message: "Push token added successfully",
      id,
    };
  } catch (error) {
    console.error("Error adding push token:", error);
    throw error;
  }
}

/**
 * Get push tokens for a user
 * @param {string} username - The username
 * @param {string} [provider] - Optional provider filter
 * @param {string} [os] - Optional OS filter
 * @returns {Promise<Array<{id: string, username: string, provider: string, os: string, token: string, created_at: string}>>}
 */
export async function getPushTokens(username, provider = null, os = null) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");

  try {
    let query = `SELECT id, username, provider, os, token, created_at FROM push_tokens WHERE username = $1`;
    const params = [username];

    if (provider) {
      params.push(provider);
      query += ` AND provider = $${params.length}`;
    }

    if (os) {
      params.push(os);
      query += ` AND os = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("Error getting push tokens:", error);
    throw error;
  }
}

/**
 * Delete a push token
 * @param {string} username - The username
 * @param {string} token - The push token to delete
 * @returns {Promise<{success: boolean, message: string, deletedCount: number}>}
 */
export async function deletePushToken(username, token) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");

  try {
    const result = await pool.query(
      `DELETE FROM push_tokens WHERE username = $1 AND token = $2`,
      [username, token]
    );

    return {
      success: true,
      message: "Push token deleted",
      deletedCount: result.rowCount,
    };
  } catch (error) {
    console.error("Error deleting push token:", error);
    throw error;
  }
}

/**
 * Send push notification using Expo
 * @param {string} username - The username to send notification to
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} [data] - Additional data payload
 * @param {string} [sound] - Sound to play
 * @param {number} [badge] - Badge number
 * @param {string} [priority] - Priority level
 * @param {number} [ttl] - Time to live in seconds
 * @param {string} [channelId] - Android notification channel
 * @param {string} [subtitle] - iOS subtitle
 * @param {string} [categoryId] - iOS category identifier
 * @returns {Promise<{success: boolean, tickets?: Array, error?: string}>}
 */
export async function sendPushNotification(
  username,
  title,
  body,
  data = null,
  sound = "default",
  badge = null,
  priority = "default",
  ttl = null,
  channelId = null,
  subtitle = null,
  categoryId = null
) {
  try {
    // Lazy load Expo SDK
    const { Expo } = await import("expo-server-sdk");

    const expo = new Expo({
      accessToken: process.env.EXPO_ACCESS_TOKEN,
    });

    // Get all push tokens for the user
    const tokens = await getPushTokens(username, "expo");

    if (tokens.length === 0) {
      return {
        success: false,
        error: "No push tokens found for user",
      };
    }

    // Build messages
    const messages = [];
    for (const tokenDoc of tokens) {
      const pushToken = tokenDoc.token;

      // Check if it's a valid Expo push token
      if (!Expo.isExpoPushToken(pushToken)) {
        console.warn(`Push token ${pushToken} is not a valid Expo push token`);
        continue;
      }

      const message = {
        to: pushToken,
        title,
        body,
      };

      if (sound) message.sound = sound;
      if (data) message.data = data;
      if (badge !== null) message.badge = badge;
      if (priority) message.priority = priority;
      if (ttl) message.ttl = ttl;
      if (channelId) message.channelId = channelId;
      if (subtitle) message.subtitle = subtitle;
      if (categoryId) message.categoryId = categoryId;

      messages.push(message);
    }

    if (messages.length === 0) {
      return {
        success: false,
        error: "No valid Expo push tokens found",
      };
    }

    // Send notifications in chunks
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);

        // Check for errors and remove invalid tokens
        for (let i = 0; i < ticketChunk.length; i++) {
          const ticket = ticketChunk[i];
          if (ticket?.status === "error") {
            if (
              ticket?.message === "DeviceNotRegistered" ||
              ticket?.details?.error === "DeviceNotRegistered"
            ) {
              // Remove the invalid token
              const invalidToken = tokens[i]?.token;
              if (invalidToken) {
                console.log(`Removing invalid token: ${invalidToken}`);
                await deletePushToken(username, invalidToken);
              }
            }
          }
        }
      } catch (error) {
        console.error("Error sending push notification chunk:", error);
      }
    }

    return {
      success: true,
      tickets,
    };
  } catch (error) {
    console.error("Error in sendPushNotification:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
