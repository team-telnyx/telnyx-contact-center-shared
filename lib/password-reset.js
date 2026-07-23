import { randomBytes } from "crypto";
import { PgDb } from "./pgdb.js";
import {
  authErrorPayload,
  authUserPayload,
  logAuthEvent,
  normalizeAuthEmail,
} from "./auth-logging.mjs";

export async function requestPasswordReset(email, { source = "unknown" } = {}) {
  const normalizedEmail = normalizeAuthEmail(email);
  logAuthEvent("info", "password_reset_requested", {
    email: normalizedEmail,
    source,
  });

  if (!normalizedEmail) {
    logAuthEvent("warn", "password_reset_request_failed", {
      reason: "missing_email",
      source,
    });
    return { ok: false, error: "Missing email", status: 400 };
  }

  try {
    const user = await PgDb.findUserByUsername(normalizedEmail);

    // Never disclose whether an account exists for the submitted address.
    if (!user) {
      logAuthEvent("info", "password_reset_request_hidden_user", {
        email: normalizedEmail,
        userExists: false,
        source,
      });
      return { ok: true };
    }

    const resetToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await PgDb.updateUserById(user.id, {
      reset_password_token: resetToken,
      reset_password_token_expires: expiresAt.toISOString(),
    });

    const { sendPasswordResetEmail } = await import("./email-notifications.js");
    const userName =
      [user.first_name, user.last_name].filter(Boolean).join(" ") ||
      user.username;
    const emailResult = await sendPasswordResetEmail(
      normalizedEmail,
      userName,
      resetToken,
    );

    if (!emailResult.success) {
      logAuthEvent("warn", "password_reset_email_failed", {
        ...authUserPayload(user, normalizedEmail),
        source,
        emailError: emailResult.error,
      });
    } else {
      logAuthEvent("info", "password_reset_email_sent", {
        ...authUserPayload(user, normalizedEmail),
        source,
      });
    }
    return { ok: true };
  } catch (error) {
    logAuthEvent("error", "password_reset_request_failed", {
      reason: "server_error",
      source,
      ...authErrorPayload(error),
    });
    return { ok: false, error: "Failed to request reset", status: 500 };
  }
}
