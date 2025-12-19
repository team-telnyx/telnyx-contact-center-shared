/**
 * Environment Detection Utility
 *
 * Separates Node.js environment (NODE_ENV) from deployment environment (APP_ENV).
 *
 * - NODE_ENV: Controls Node.js optimizations (development vs production)
 * - APP_ENV: Controls business logic (development, staging, production)
 *
 * Usage:
 *   import { isProductionDeployment, getAppEnv, isDevelopmentLike } from '@/lib/environment';
 *
 *   if (isDevelopmentLike()) {
 *     // Use dev suffix and tags for provisioning
 *   }
 */

/**
 * Get the application deployment environment
 * @returns {'development' | 'staging' | 'production'}
 */
export function getAppEnv() {
  const appEnv = process.env.APP_ENV || process.env.NODE_ENV || "development";

  // Normalize to one of the three valid values
  if (appEnv === "staging") return "staging";
  if (appEnv === "production") return "production";
  return "development";
}

/**
 * Check if this is the actual production deployment
 * @returns {boolean}
 */
export function isProductionDeployment() {
  return getAppEnv() === "production";
}

/**
 * Check if this is a development-like environment (development or staging)
 * For provisioning logic that should use dev suffix and tags
 * @returns {boolean}
 */
export function isDevelopmentLike() {
  const env = getAppEnv();
  return env === "development" || env === "staging";
}

/**
 * Check if this is staging environment specifically
 * @returns {boolean}
 */
export function isStagingDeployment() {
  return getAppEnv() === "staging";
}

/**
 * Check if this is development environment specifically
 * @returns {boolean}
 */
export function isDevelopmentDeployment() {
  return getAppEnv() === "development";
}

/**
 * Get environment-specific suffix for resource naming
 * @returns {string} Empty string for production, "-dev" for development/staging
 */
export function getEnvSuffix() {
  return isDevelopmentLike() ? "-dev" : "";
}

/**
 * Get environment-specific tags for Telnyx resources
 * @param {string} username - Username to include in tags
 * @returns {string[]} Array of tags
 */
export function getEnvTags(username) {
  const baseTags = ["DemoPortal", username];

  if (isStagingDeployment()) {
    baseTags.push("staging");
  } else if (isDevelopmentDeployment()) {
    baseTags.push("development");
  }

  return baseTags;
}

/**
 * Get a human-readable environment name
 * @returns {string}
 */
export function getEnvName() {
  const env = getAppEnv();
  return env.charAt(0).toUpperCase() + env.slice(1);
}
