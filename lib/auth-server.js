import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { verifyAccessToken } from "@/lib/jwt";
import { headers } from "next/headers";
import { authLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

/**
 * Get authenticated user from either JWT Bearer token (mobile app) or NextAuth session (web app)
 * Also supports token in query parameters for audio streaming endpoints
 * @param {URL} requestUrl - Optional request URL to check for token query parameter
 * @returns {Promise<Object|null>} User object or null if not authenticated
 */
export async function getAuthenticatedUser(requestUrl = null) {
  try {
    let token = null;

    // First, try JWT Bearer token from Authorization header (for mobile app)
    const headersList = await headers();
    const authHeader = headersList.get("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    token = match?.[1];

    // If no token in header, try query parameter (for audio streaming)
    if (!token && requestUrl) {
      const url = new URL(requestUrl);
      token = url.searchParams.get("token");
    }

    if (token) {
      try {
        const payload = await verifyAccessToken(token);
        if (payload?.sub) {
          const user = await PgDb.findUserById(String(payload.sub));
          if (user) return user;
        }
      } catch (jwtErr) {
        // JWT verification failed, try session auth
        authLogger.warn("jwt_verification_failed_session_fallback", { ...securityErrorPayload(jwtErr) });
      }
    }

    // Fall back to NextAuth session (for web app)
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const email = session?.user?.email || null;
    if (!userId && !email) return null;

    let user = null;
    if (userId) {
      user = await PgDb.findUserById(userId);
    }
    if (!user && email) {
      user = await PgDb.findUserByUsername(email);
    }
    return user;
  } catch (err) {
    authLogger.error("authenticated_user_lookup_failed", { ...securityErrorPayload(err) });
    return null;
  }
}

/**
 * Get authenticated user or throw 401 error
 * @returns {Promise<Object>} User object
 * @throws {Error} If user is not authenticated
 */
export async function requireAuth() {
  const user = await getAuthenticatedUser();
  if (!user) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  return user;
}
