"use server";

import { authenticateUser } from "@/lib/auth";
import { PgDb } from "@/lib/pgdb";
import { signAccessToken, signRefreshToken, hashToken } from "@/lib/jwt";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomBytes, pbkdf2Sync } from "crypto";
import { createUserTelephonyCredentials } from "@/lib/telnyx-credentials";
import { verifyRecaptcha, isRecaptchaConfigured } from "@/lib/recaptcha";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail, REDACTED } from "@/lib/auth-logging.mjs";

export async function loginAction(prevState, formData) {
  const username = normalizeAuthEmail(formData.get("username"));
  const password = (formData.get("password") || "").toString();
  logAuthEvent("info", "signin_attempt", { method: "credentials", email: username });
  const user = await authenticateUser(username, password);
  if (!user) {
    logAuthEvent("warn", "signin_failed", { method: "credentials", email: username, reason: "invalid_credentials" });
    return { ok: false, error: "Invalid credentials" };
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
        await PgDb.updateUserById(String(user.id || user._id), {
          telephonyCredentialsId: credential.id,
          telephonyUserName: credential.username || credential.sip_username,
        });
        logAuthEvent("info", "auth_telephony_credentials_created", {
          ...authUserPayload(user, username),
          credentialId: credential.id,
          source: "login_action",
        });
      }
    } catch (credErr) {
      logAuthEvent("warn", "auth_telephony_credentials_failed", {
        ...authUserPayload(user, username),
        source: "login_action",
        ...authErrorPayload(credErr),
      });
      // Continue login even if credential creation fails
    }
  }

  const accessToken = await signAccessToken(
    {
      sub: String(user.id || user._id),
      email: user.username,
      username: user.username,
    },
    "1d"
  );
  const refreshToken = await signRefreshToken(
    { sub: String(user.id || user._id), purpose: "refresh" },
    "30d"
  );
  await PgDb.updateUserById(String(user.id || user._id), {
    refresh_tokens: [{ refreshToken: await hashToken(refreshToken) }],
  });
  logAuthEvent("info", "signin_success", { method: "credentials", ...authUserPayload(user, username) });
  const { cookies } = await import("next/headers");
  (await cookies()).set({
    name: "session",
    value: accessToken,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 1,
  });
  (await cookies()).set({
    name: "refresh_token",
    value: refreshToken,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  return { ok: true };
}

export async function signupAction(formData) {
  try {
    const username = normalizeAuthEmail(formData.get("username"));
    const password = (formData.get("password") || "").toString();
    const firstName = (formData.get("firstName") || "").toString();
    const lastName = (formData.get("lastName") || "").toString();
    const mobile = (formData.get("mobile") || "").toString();
    const recaptchaToken = (formData.get("recaptchaToken") || "").toString();
    logAuthEvent("info", "signup_attempt", { method: "local", email: username });

    // Verify reCAPTCHA if configured
    if (isRecaptchaConfigured()) {
      if (!recaptchaToken) {
        logAuthEvent("warn", "signup_failed", { method: "local", email: username, reason: "recaptcha_missing", recaptchaToken: REDACTED });
        return { ok: false, error: "Security verification required" };
      }

      const verificationResult = await verifyRecaptcha(
        recaptchaToken,
        "signup",
        0.5 // Minimum score of 0.5 (adjust based on your needs)
      );

      if (!verificationResult.success) {
        logAuthEvent("warn", "signup_failed", {
          method: "local",
          email: username,
          reason: "recaptcha_failed",
          recaptchaError: verificationResult.error,
        });
        return {
          ok: false,
          error:
            "Security verification failed. Please try again or contact support.",
        };
      }

      logAuthEvent("info", "signup_recaptcha_passed", {
        method: "local",
        email: username,
        recaptchaScore: verificationResult.score,
      });
    } else {
      logAuthEvent("warn", "signup_recaptcha_skipped", { method: "local", email: username, reason: "not_configured" });
    }

    if (!username || !password || !firstName || !lastName || !mobile) {
      logAuthEvent("warn", "signup_failed", { method: "local", email: username, reason: "missing_required_fields" });
      return { ok: false, error: "Missing required fields" };
    }
    const strong =
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password) &&
      password.length >= 8;
    if (!strong) {
      logAuthEvent("warn", "signup_failed", { method: "local", email: username, reason: "weak_password" });
      return { ok: false, error: "Password too weak" };
    }
    const at = username.indexOf("@");
    if (at < 1 || at === username.length - 1) {
      logAuthEvent("warn", "signup_failed", { method: "local", email: username, reason: "invalid_email" });
      return { ok: false, error: "Invalid email" };
    }
    const domain = username.slice(at + 1).toLowerCase();

    const pool = getPostgresPool();
    const domainDoc = (
      await pool.query(
        "SELECT * FROM domains WHERE domain=$1 AND active=true LIMIT 1",
        [domain]
      )
    ).rows?.[0];
    if (!domainDoc) {
      logAuthEvent("warn", "signup_failed", { method: "local", email: username, domain, reason: "domain_not_allowed" });
      return { ok: false, error: "Email domain not allowed" };
    }

    const existing = await PgDb.findUserByUsername(username);
    if (existing) {
      logAuthEvent("warn", "signup_failed", { method: "local", email: username, reason: "user_exists" });
      return { ok: false, error: "User already exists" };
    }

    const salt = randomBytes(32).toString("hex");
    const hash = pbkdf2Sync(password, salt, 25000, 64, "sha256").toString(
      "hex"
    );
    const iterations = 25000;

    // Generate activation token
    const activationToken = randomBytes(32).toString("hex");
    const activationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const id = await PgDb.upsertUserByUsername(username, {
      firstName,
      lastName,
      nick: firstName,
      mobile,
      hash,
      salt,
      iterations,
      verified: false,
      authStrategy: "local",
      activationToken,
      activationTokenExpires: activationExpires.toISOString(),
    });

    // Create Telnyx telephony credentials for the user
    try {
      const credential = await createUserTelephonyCredentials({
        email: username,
        firstName,
        lastName,
      });

      if (credential) {
        // Update user with telephony credentials
        await PgDb.updateUserById(String(id), {
          telephonyCredentialsId: credential.id,
          telephonyUserName: credential.username || credential.sip_username,
        });
        logAuthEvent("info", "auth_telephony_credentials_created", {
          userId: String(id),
          email: username,
          credentialId: credential.id,
          source: "signup_action",
        });
      }
    } catch (credErr) {
      logAuthEvent("warn", "auth_telephony_credentials_failed", {
        userId: String(id),
        email: username,
        source: "signup_action",
        ...authErrorPayload(credErr),
      });
      // Continue even if credential creation fails (user signup should still succeed)
    }

    // Send activation email
    try {
      const { sendActivationEmail } = await import("@/lib/email-notifications");
      const userName = [firstName, lastName].filter(Boolean).join(" ");
      const emailResult = await sendActivationEmail(
        username,
        userName,
        activationToken
      );

      if (!emailResult.success) {
        logAuthEvent("warn", "signup_activation_email_failed", {
          userId: String(id),
          email: username,
          emailError: emailResult.error,
        });
      }
    } catch (emailErr) {
      logAuthEvent("warn", "signup_activation_email_failed", {
        userId: String(id),
        email: username,
        ...authErrorPayload(emailErr),
      });
      // Continue even if email fails
    }

    logAuthEvent("info", "signup_success", { userId: String(id), email: username, method: "local" });
    return { ok: true, id: String(id) };
  } catch (err) {
    logAuthEvent("error", "signup_failed", { reason: "server_error", ...authErrorPayload(err) });
    return { ok: false, error: "Server error" };
  }
}

export async function forgotPasswordAction(formData) {
  try {
    const username = normalizeAuthEmail(formData.get("username"));
    logAuthEvent("info", "password_reset_requested", { email: username, source: "server_action" });
    if (!username) {
      logAuthEvent("warn", "password_reset_request_failed", { reason: "missing_email", source: "server_action" });
      return { ok: false, error: "Missing email" };
    }

    // Find user
    const user = await PgDb.findUserByUsername(username);

    // For security, don't disclose if user exists or not
    if (!user) {
      // Return success even if user doesn't exist
      logAuthEvent("info", "password_reset_request_hidden_user", { email: username, userExists: false, source: "server_action" });
      return { ok: true };
    }

    // Generate secure random token
    const resetToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    // Save token to database
    await PgDb.updateUserById(user.id, {
      reset_password_token: resetToken,
      reset_password_token_expires: expiresAt.toISOString(),
    });

    // Send password reset email
    const { sendPasswordResetEmail } = await import(
      "@/lib/email-notifications"
    );
    const userName =
      [user.first_name, user.last_name].filter(Boolean).join(" ") ||
      user.username;

    const emailResult = await sendPasswordResetEmail(
      username,
      userName,
      resetToken
    );

    if (!emailResult.success) {
      logAuthEvent("warn", "password_reset_email_failed", {
        ...authUserPayload(user, username),
        source: "server_action",
        emailError: emailResult.error,
      });
      // Still return success to not disclose if email sending failed
    } else {
      logAuthEvent("info", "password_reset_email_sent", { ...authUserPayload(user, username), source: "server_action" });
    }
    return { ok: true };
  } catch (err) {
    logAuthEvent("error", "password_reset_request_failed", { reason: "server_error", source: "server_action", ...authErrorPayload(err) });
    return { ok: false, error: "Failed to request reset" };
  }
}
