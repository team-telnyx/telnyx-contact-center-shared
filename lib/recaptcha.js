/**
 * Google reCAPTCHA v3 Verification
 * Docs: https://developers.google.com/recaptcha/docs/v3
 */

/**
 * Verify a reCAPTCHA token with Google's API
 * @param {string} token - The reCAPTCHA token from the client
 * @param {string} expectedAction - The expected action name (e.g., 'register')
 * @param {number} minimumScore - Minimum acceptable score (0.0-1.0, default 0.5)
 * @returns {Promise<{success: boolean, score?: number, error?: string}>}
 */
export async function verifyRecaptcha(
  token,
  expectedAction = "register",
  minimumScore = 0.5
) {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  if (!secretKey) {
    console.error("[reCAPTCHA] Secret key not configured");
    return {
      success: false,
      error: "reCAPTCHA not configured on server",
    };
  }

  if (!token) {
    return {
      success: false,
      error: "reCAPTCHA token is required",
    };
  }

  try {
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: secretKey,
          response: token,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    console.log("[reCAPTCHA] Verification result:", {
      success: data.success,
      score: data.score,
      action: data.action,
      hostname: data.hostname,
    });

    // Check if verification was successful
    if (!data.success) {
      const errorCodes = data["error-codes"] || [];
      return {
        success: false,
        error: `reCAPTCHA verification failed: ${errorCodes.join(", ")}`,
      };
    }

    // Verify the action matches what we expect
    if (data.action !== expectedAction) {
      return {
        success: false,
        error: `Action mismatch: expected '${expectedAction}', got '${data.action}'`,
      };
    }

    // Check the score (0.0 = bot, 1.0 = human)
    if (data.score < minimumScore) {
      return {
        success: false,
        score: data.score,
        error: `Score too low: ${data.score} (minimum: ${minimumScore})`,
      };
    }

    return {
      success: true,
      score: data.score,
    };
  } catch (error) {
    console.error("[reCAPTCHA] Verification error:", error);
    return {
      success: false,
      error: `Verification failed: ${error.message}`,
    };
  }
}

/**
 * Get the reCAPTCHA site key for client-side usage
 * @returns {string|null}
 */
export function getRecaptchaSiteKey() {
  return process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || null;
}

/**
 * Check if reCAPTCHA is properly configured
 * @returns {boolean}
 */
export function isRecaptchaConfigured() {
  return !!(
    process.env.RECAPTCHA_SECRET_KEY &&
    process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY
  );
}
