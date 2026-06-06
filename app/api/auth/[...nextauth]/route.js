import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Facebook from "next-auth/providers/facebook";
import Credentials from "next-auth/providers/credentials";
import { PostgresNextAuthAdapter } from "@/lib/nextauth-pg-adapter";
import { PgDb } from "@/lib/pgdb";
import { verifyUserPassword } from "@/lib/auth";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { createUserTelephonyCredentials } from "@/lib/telnyx-credentials";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail } from "@/lib/auth-logging.mjs";

export const authOptions = {
  adapter: PostgresNextAuthAdapter(),
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  trustHost: true,
  // debug: process.env.NODE_ENV !== "production",
  providers: [
    Google({
      clientId: process.env.GOOGLE_ID,
      clientSecret: process.env.GOOGLE_SECRET,
    }),
    GitHub({
      clientId: process.env.GITHUB_ID,
      clientSecret: process.env.GITHUB_SECRET,
    }),
    Facebook({
      clientId: process.env.FACEBOOK_ID,
      clientSecret: process.env.FACEBOOK_SECRET,
    }),
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const username = normalizeAuthEmail(creds?.username);
        const password = (creds?.password || "").toString();
        logAuthEvent("info", "signin_attempt", { method: "nextauth_credentials", email: username, source: "nextauth" });
        if (!username || !password) {
          await logAuthEvent("warn", "signin_failed", { method: "nextauth_credentials", email: username, source: "nextauth", reason: "missing_required_fields" });
          return null;
        }
        const user = await PgDb.findUserByUsername(username);
        if (user && verifyUserPassword(user, password)) {
          // Check if account is verified
          if (!user.verified && user.auth_strategy === "local") {
            await logAuthEvent("warn", "signin_failed", { method: "nextauth_credentials", source: "nextauth", reason: "account_not_verified", ...authUserPayload(user, username) });
            throw new Error(
              "Please verify your email address before signing in"
            );
          }

          // Check if user has telephony credentials, create if missing
          if (!user.telephony_credentials_id && !user.telephonyCredentialsId) {
            try {
              const credential = await createUserTelephonyCredentials({
                email: user.username || username,
                firstName: user.first_name || user.firstName || "",
                lastName: user.last_name || user.lastName || "",
              });

              if (credential) {
                // Update user with telephony credentials
                await PgDb.updateUserById(user.id, {
                  telephonyCredentialsId: credential.id,
                  telephonyUserName:
                    credential.username || credential.sip_username,
                });
                logAuthEvent("info", "auth_telephony_credentials_created", { ...authUserPayload(user, username), credentialId: credential.id, source: "nextauth_authorize" });
              }
            } catch (credErr) {
              logAuthEvent("warn", "auth_telephony_credentials_failed", { ...authUserPayload(user, username), source: "nextauth_authorize", ...authErrorPayload(credErr) });
              // Continue login even if credential creation fails
            }
          }

          await logAuthEvent("info", "signin_success", { method: "nextauth_credentials", source: "nextauth", ...authUserPayload(user, username) });
          return {
            id: String(user.id),
            email: user.username,
            name:
              [
                user.first_name || user.firstName,
                user.last_name || user.lastName,
              ]
                .filter(Boolean)
                .join(" ") || user.username,
          };
        }
        await logAuthEvent("warn", "signin_failed", { method: "nextauth_credentials", email: username, source: "nextauth", reason: "invalid_credentials" });
        return null;
      },
    }),
  ],
  callbacks: {
    async redirect({ url, baseUrl }) {
      try {
        // If url is provided and it's a relative path, use the current origin
        if (url && url.startsWith("/")) {
          // Check if we're in a tunnel environment by looking at the baseUrl
          if (baseUrl.includes("tunnel.demotelnyx.com")) {
            return `https://tunnel.demotelnyx.com${url}`;
          }
          // Use the NEXTAUTH_URL if set, otherwise use baseUrl
          const redirectBase = process.env.NEXTAUTH_URL || baseUrl;
          return `${redirectBase}${url}`;
        }

        // If url is absolute, validate it's from the same origin
        if (url) {
          const u = new URL(url);
          const currentOrigin = process.env.NEXTAUTH_URL || baseUrl;
          const currentUrl = new URL(currentOrigin);

          // If it's the same origin, allow it
          if (u.origin === currentUrl.origin) {
            return url;
          }
        }

        // Default to home page
        if (baseUrl.includes("tunnel.demotelnyx.com")) {
          return `https://tunnel.demotelnyx.com/`;
        }
        const defaultUrl = process.env.NEXTAUTH_URL || baseUrl;
        return `${defaultUrl}/`;
      } catch (_) {}
      return `${baseUrl}/`;
    },
    async signIn({ user, account, profile }) {
      try {
        // Track login activity (deferred to session callback where we have user ID)
        // We'll track it in the session callback instead

        if (account?.provider === "google") {
          logAuthEvent("info", "signin_attempt", { method: "google", source: "nextauth" });
          const email = String(
            user?.email || profile?.email || ""
          ).toLowerCase();
          if (email) {
            let existing = await PgDb.findUserByUsername(email);
            const googleImage = user?.image || profile?.picture || "";

            if (existing) {
              if (!existing.profile_picture_uri && googleImage) {
                await PgDb.updateUserById(existing.id, {
                  profile_picture_uri: googleImage,
                });
              }
            } else {
              // Enforce allowed domain for new registrations (same rule as password signup)
              const at = email.indexOf("@");
              const domain = at > 0 ? email.slice(at + 1).toLowerCase() : "";
              const pool = getPostgresPool();
              const domainDoc = domain
                ? (
                    await pool.query(
                      "SELECT * FROM domains WHERE domain=$1 AND active=true LIMIT 1",
                      [domain]
                    )
                  ).rows?.[0]
                : null;
              if (!domainDoc) {
                logAuthEvent("warn", "signup_failed", { method: "google", source: "nextauth", email, domain, reason: "domain_not_allowed" });
                // Redirect back to signup with error
                return "/signup?error=EmailDomainNotAllowed";
              }

              const firstName =
                profile?.given_name || (user?.name || "").split(" ")[0] || "";
              const lastName =
                profile?.family_name ||
                (user?.name || "").split(" ").slice(1).join(" ") ||
                "";

              try {
                await PgDb.upsertUserByUsername(email, {
                  firstName,
                  lastName,
                  nick: firstName,
                  profilePictureUri: googleImage || "",
                  verified: true,
                  authStrategy: "google",
                });
                existing = await PgDb.findUserByUsername(email);
                logAuthEvent("info", "signup_success", { method: "google", source: "nextauth", ...authUserPayload(existing, email) });

                // Create Telnyx telephony credentials for the new user
                if (existing) {
                  try {
                    const credential = await createUserTelephonyCredentials({
                      email,
                      firstName,
                      lastName,
                    });

                    if (credential) {
                      // Update user with telephony credentials
                      await PgDb.updateUserById(existing.id, {
                        telephonyCredentialsId: credential.id,
                        telephonyUserName:
                          credential.username || credential.sip_username,
                      });
                      logAuthEvent("info", "auth_telephony_credentials_created", { ...authUserPayload(existing, email), credentialId: credential.id, source: "nextauth_oauth_signup" });
                    }
                  } catch (credErr) {
                    logAuthEvent("warn", "auth_telephony_credentials_failed", { ...authUserPayload(existing, email), source: "nextauth_oauth_signup", ...authErrorPayload(credErr) });
                    // Continue even if credential creation fails
                  }
                }
              } catch (_) {
                // In case of race, try to find again
                existing = await PgDb.findUserByUsername(email);
              }
            }
          }
        }
      } catch (_) {}
      return true;
    },
    async jwt({ token, user, account, profile, trigger }) {
      // For OAuth providers (especially Google), always use the app's users table ID
      // not the NextAuth auth_users table ID
      if (account?.provider === "google" && profile?.email) {
        try {
          const email = String(profile.email).toLowerCase();
          const existing = await PgDb.findUserByUsername(email);
          if (existing) {
            // Always use the app's users table ID for Google OAuth
            token.id = String(existing.id);
            token.email = existing.username || token.email;
            token.setupCompleted = existing.setup_completed ?? false;
            if (profile.picture) token.picture = profile.picture;
            logAuthEvent("info", "signin_success", { method: "google", source: "nextauth_jwt", ...authUserPayload(existing, profile.email) });
          }
        } catch (err) {
          logAuthEvent("warn", "signin_failed", { method: "google", source: "nextauth_jwt", reason: "user_lookup_failed", ...authErrorPayload(err) });
        }
      } else if (user) {
        // For credentials auth, use the user.id from the authorize function
        // which already returns the correct app users table ID
        if (user.id) {
          token.id = user.id;
        }
        token.email = user.email || token.email;
        token.picture = user.image || token.picture;
      }

      // Always fetch latest user data from database to ensure we have the correct ID
      if (token?.email) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Database query timeout")), 5000)
          );

          const dbUserPromise = PgDb.findUserByUsername(token.email);
          const dbUser = await Promise.race([dbUserPromise, timeoutPromise]);

          if (dbUser) {
            // Ensure we're using the correct ID from the app's users table
            token.id = String(dbUser.id);
            token.setupCompleted = dbUser.setup_completed ?? false;

            // Check if user has telephony credentials, create if missing
            if (
              !dbUser.telephony_credentials_id &&
              !dbUser.telephonyCredentialsId
            ) {
              try {
                const credential = await createUserTelephonyCredentials({
                  email: dbUser.username || token.email,
                  firstName: dbUser.first_name || dbUser.firstName || "",
                  lastName: dbUser.last_name || dbUser.lastName || "",
                });

                if (credential) {
                  // Update user with telephony credentials
                  await PgDb.updateUserById(dbUser.id, {
                    telephonyCredentialsId: credential.id,
                    telephonyUserName:
                      credential.username || credential.sip_username,
                  });
                  logAuthEvent("info", "auth_telephony_credentials_created", { ...authUserPayload(dbUser, token.email), credentialId: credential.id, source: "nextauth_jwt" });
                }
              } catch (credErr) {
                logAuthEvent("warn", "auth_telephony_credentials_failed", { ...authUserPayload(dbUser, token.email), source: "nextauth_jwt", ...authErrorPayload(credErr) });
                // Continue even if credential creation fails
              }
            }
          }
        } catch (err) {
          logAuthEvent("warn", "nextauth_jwt_user_lookup_failed", { email: token.email, source: "nextauth_jwt", ...authErrorPayload(err) });
          // Keep existing token values on error
        }
      }

      return token;
    },
    async session({ session, token, trigger }) {
      if (token?.id) {
        session.user.id = token.id;
      }
      if (token?.email) {
        session.user.email = token.email;
      }
      if (token?.picture && !session.user.image) {
        session.user.image = token.picture;
      }

      // Fetch user role from database with timeout protection
      // Always look up by email first to ensure we get the correct user ID from app's users table
      if (token?.email) {
        try {
          // Add timeout to prevent hanging requests
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Database query timeout")), 5000)
          );

          const userPromise = (async () => {
            // Always look up by email to get the correct user from app's users table
            let user = await PgDb.findUserByUsername(token.email);

            // If not found by email, try by token.id as fallback
            if (!user && token?.id) {
              user = await PgDb.findUserById(token.id);
            }

            return user;
          })();

          const user = await Promise.race([userPromise, timeoutPromise]);

          if (user) {
            // Always use the ID from the app's users table, not from NextAuth's auth_users table
            session.user.id = String(user.id);
            session.user.roles = user.roles || ["agent"];
            session.user.username = user.username;
            session.user.firstName = user.first_name;
            session.user.lastName = user.last_name;
            session.user.setupCompleted = user.setup_completed || false;

            // Update token.id to ensure it's correct for future requests
            token.id = String(user.id);

            // Track login activity on first session creation (when token doesn't have login tracked)
            if (!token.loginTracked && user.id) {
              try {
                // Check if there's already a recent login session (within last minute) to avoid duplicates
                const pool = await import("@/lib/postgres.mjs").then((m) =>
                  m.getPostgresPool()
                );
                if (pool) {
                  const recentSession = await pool.query(
                    `SELECT id FROM cc_user_sessions 
                     WHERE user_id = $1 AND login_at > NOW() - INTERVAL '1 minute'
                     ORDER BY login_at DESC LIMIT 1`,
                    [String(user.id)]
                  );

                  if (recentSession.rows.length === 0) {
                    // Log user session (login)
                    await PgDb.logUserSession({
                      userId: String(user.id),
                      loginAt: new Date().toISOString(),
                    });

                    // Log login activity
                    await PgDb.logUserActivity({
                      userId: String(user.id),
                      activityType: "login",
                      activityValue: "session_created",
                    });

                    // Mark token as having login tracked to avoid duplicates
                    token.loginTracked = true;
                  }
                }
              } catch (activityError) {
                logAuthEvent("warn", "signin_activity_log_failed", { ...authUserPayload(user, token.email), source: "nextauth_session", ...authErrorPayload(activityError) });
                // Don't fail session creation if activity logging fails
              }
            }

            // Check if user has telephony credentials, create if missing
            if (
              !user.telephony_credentials_id &&
              !user.telephonyCredentialsId
            ) {
              try {
                const credential = await createUserTelephonyCredentials({
                  email: user.username || token.email,
                  firstName: user.first_name || user.firstName || "",
                  lastName: user.last_name || user.lastName || "",
                });

                if (credential) {
                  // Update user with telephony credentials
                  await PgDb.updateUserById(user.id, {
                    telephonyCredentialsId: credential.id,
                    telephonyUserName:
                      credential.username || credential.sip_username,
                  });
                  logAuthEvent("info", "auth_telephony_credentials_created", { ...authUserPayload(user, token.email), credentialId: credential.id, source: "nextauth_session" });
                }
              } catch (credErr) {
                logAuthEvent("warn", "auth_telephony_credentials_failed", { ...authUserPayload(user, token.email), source: "nextauth_session", ...authErrorPayload(credErr) });
                // Continue even if credential creation fails
              }
            }
          }
        } catch (error) {
          logAuthEvent("warn", "nextauth_session_failed", { email: token.email, source: "nextauth_session", ...authErrorPayload(error) });
          // Return session with existing token data on error
          // This prevents the entire session from failing
        }
      } else if (token?.id) {
        // Fallback: if no email, try to find by ID
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Database query timeout")), 5000)
          );

          const userPromise = PgDb.findUserById(token.id);
          const user = await Promise.race([userPromise, timeoutPromise]);

          if (user) {
            session.user.id = String(user.id);
            session.user.roles = user.roles || ["agent"];
            session.user.username = user.username;
            session.user.firstName = user.first_name;
            session.user.lastName = user.last_name;
            session.user.setupCompleted = user.setup_completed || false;
          }
        } catch (error) {
          logAuthEvent("warn", "nextauth_session_failed", { userId: token?.id ? String(token.id) : undefined, source: "nextauth_session", ...authErrorPayload(error) });
        }
      }

      return session;
    },
  },
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
