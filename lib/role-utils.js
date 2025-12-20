/**
 * Utility functions for role management
 * Supports both legacy single role and new multiple roles array
 */

/**
 * Get user roles as an array
 * @param {Object} user - User object from database
 * @returns {string[]} Array of role strings
 */
export function getUserRoles(user) {
  if (!user) return [];

  // Prefer roles array if available
  if (user.roles && Array.isArray(user.roles) && user.roles.length > 0) {
    return user.roles.map((r) => String(r || "").toLowerCase()).filter(Boolean);
  }

  // Fallback to legacy role field
  if (user.role) {
    return [String(user.role).toLowerCase()];
  }

  return ["agent"]; // Default
}

/**
 * Check if user has a specific role
 * @param {Object} user - User object from database
 * @param {string|string[]} requiredRoles - Single role or array of roles to check
 * @returns {boolean} True if user has any of the required roles
 */
export function hasRole(user, requiredRoles) {
  const userRoles = getUserRoles(user);
  const rolesToCheck = Array.isArray(requiredRoles)
    ? requiredRoles
    : [requiredRoles];

  return rolesToCheck.some((role) =>
    userRoles.includes(String(role).toLowerCase())
  );
}

/**
 * Check if user has admin or owner role
 * @param {Object} user - User object from database
 * @returns {boolean} True if user is admin or owner
 */
export function isAdmin(user) {
  return hasRole(user, ["admin", "owner"]);
}

/**
 * Check if user has agent role
 * @param {Object} user - User object from database
 * @returns {boolean} True if user has agent role
 */
export function isAgent(user) {
  return hasRole(user, "agent");
}

/**
 * Check if user has supervisor role
 * @param {Object} user - User object from database
 * @returns {boolean} True if user has supervisor role
 */
export function isSupervisor(user) {
  return hasRole(user, "supervisor");
}

/**
 * Check if user has supervisor or admin/owner role
 * @param {Object} user - User object from database
 * @returns {boolean} True if user is supervisor, admin, or owner
 */
export function isSupervisorOrAdmin(user) {
  return hasRole(user, ["supervisor", "admin", "owner"]);
}

/**
 * Normalize roles array - ensure it's a valid array of role strings
 * @param {string|string[]|null|undefined} roles - Roles to normalize
 * @returns {string[]} Normalized array of role strings
 */
export function normalizeRoles(roles) {
  if (!roles) return ["agent"];
  if (Array.isArray(roles)) {
    return roles
      .map((r) =>
        String(r || "")
          .toLowerCase()
          .trim()
      )
      .filter(Boolean);
  }
  return [String(roles).toLowerCase().trim()].filter(Boolean);
}
