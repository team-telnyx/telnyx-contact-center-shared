import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "./runtime-logging.mjs";

/**
 * Fetch the brand-primary color from app_settings theme configuration.
 * Falls back to Telnyx green (#00BC8C) if not configured or on error.
 * @returns {Promise<string>} Hex color string
 */
async function getBrandPrimaryColor() {
  try {
    const pool = getPostgresPool();
    if (!pool) return "#00BC8C";
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT theme_colors_hex FROM app_settings WHERE id = 'default' LIMIT 1"
      );
      if (result.rows.length > 0) {
        const hex = result.rows[0].theme_colors_hex;
        return hex?.light?.["brand-primary"] || "#00BC8C";
      }
    } finally {
      client.release();
    }
  } catch (e) {
    // fall through to default
  }
  return "#00BC8C";
}

/**
 * Send email notification using Mailgun API
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - HTML content of the email
 * @param {string} text - Plain text content (optional)
 * @param {Object} options - Additional options (inlineAttachments)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendEmailNotification(
  to,
  subject,
  html,
  text = null,
  options = {}
) {
  try {
    const emailApiKey = process.env.EMAIL_API_KEY;
    const emailDomain = process.env.EMAIL_DOMAIN;
    const emailFrom = process.env.EMAIL_FROM;

    if (!emailApiKey || !emailDomain || !emailFrom) {
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return { success: false, error: "Server not configured for email" };
    }

    if (!to || !subject || !html) {
      return { success: false, error: "Missing required email parameters" };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return { success: false, error: "Invalid email address format" };
    }

    const mailgunUrl = `https://api.mailgun.net/v3/${emailDomain}/messages`;

    // Check if we have inline attachments
    if (
      options.inlineAttachments &&
      Array.isArray(options.inlineAttachments) &&
      options.inlineAttachments.length > 0
    ) {
      // Use form-data for attachments
      const FormData = (await import("form-data")).default;
      const formData = new FormData();

      formData.append("from", emailFrom);
      formData.append("to", to);
      formData.append("subject", subject);
      formData.append("html", html);
      if (text) {
        formData.append("text", text);
      }

      // Add inline attachments (CID attachments for email images)
      for (const attachment of options.inlineAttachments) {
        if (attachment.data && attachment.filename) {
          formData.append("inline", attachment.data, {
            filename: attachment.filename,
            contentType: attachment.contentType || "image/png",
          });
        }
      }

      // Use form-data's submit method instead of fetch
      return new Promise((resolve) => {
        formData.submit(
          {
            protocol: "https:",
            host: "api.mailgun.net",
            path: `/v3/${emailDomain}/messages`,
            auth: `api:${emailApiKey}`,
            headers: formData.getHeaders(),
          },
          (err, res) => {
            if (err) {
              adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
              resolve({ success: false, error: err.message });
              return;
            }

            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => {
              try {
                const data = JSON.parse(body);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  resolve({ success: true, messageId: data.id });
                } else {
                  resolve({
                    success: false,
                    error: data.message || "Failed to send email",
                  });
                }
              } catch (parseError) {
                resolve({ success: false, error: "Failed to parse response" });
              }
            });
          }
        );
      });
    } else {
      // No attachments - use simple URLSearchParams
      const formData = new URLSearchParams();
      formData.append("from", emailFrom);
      formData.append("to", to);
      formData.append("subject", subject);
      formData.append("html", html);
      if (text) {
        formData.append("text", text);
      }

      const response = await fetch(mailgunUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${emailApiKey}`).toString(
            "base64"
          )}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMessage = data?.message || "Failed to send email";
        adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
        return { success: false, error: errorMessage };
      }

      return {
        success: true,
        messageId: data?.id || null,
      };
    }
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

/**
 * Generate HTML email template for visitor registration confirmation
 * @param {Object} visitorData - Visitor data object
 * @param {string} baseUrl - Base URL for the demo portal
 * @returns {Promise<string>} HTML email content
 */
export async function generateRegistrationEmailHTML(visitorData, baseUrl) {
  const { first_name, last_name, unique_id, expires_at } = visitorData;
  const visitorName = first_name
    ? `${first_name}${last_name ? ` ${last_name}` : ""}`
    : "there";
  const demoPortalUrl = `${baseUrl}/demo/${unique_id}`;

  // Format expiration date
  const formatExpirationDate = (expiresAt) => {
    if (!expiresAt) return "Not specified";
    const date = new Date(expiresAt);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  };

  const formattedExpirationDate = formatExpirationDate(expires_at);

  // Use the QR code data URL directly from the visitor data (already stored as base64)
  // This avoids authentication issues with email clients loading images
  const qrCodeDataUrl = visitorData.qr_code_data_url;

  adminRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });

  // Verify the data URL is valid
  if (qrCodeDataUrl && !qrCodeDataUrl.startsWith("data:image/")) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Registration Successful - Telnyx Contact Center</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background-color: #000000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #ffffff;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }

        .card {
            background-color: #1a1a1a;
            border-radius: 12px;
            padding: 30px;
            text-align: center;
        }
        .success-icon {
            width: 60px;
            height: 60px;
            background-color: #00d4aa;
            border-radius: 50%;
            margin: 0 auto 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 30px;
            color: #000000;
        }
        .success-title {
            font-size: 24px;
            font-weight: bold;
            color: #ffffff;
            margin-bottom: 10px;
        }
        .success-message {
            color: #cccccc;
            margin-bottom: 20px;
            line-height: 1.5;
        }
        .verified-badge {
            display: inline-block;
            background-color: transparent;
            border: 2px solid #00d4aa;
            color: #00d4aa;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 30px;
        }
        .qr-section {
            margin-bottom: 30px;
        }
        .qr-label {
            color: #ffffff;
            font-size: 16px;
            margin-bottom: 15px;
        }
        .qr-code {
            width: 200px;
            height: 200px;
            margin: 0 auto;
            border-radius: 8px;
            overflow: hidden;
        }
        .qr-code img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .link-section {
            margin-bottom: 30px;
        }
        .link-label {
            color: #ffffff;
            font-size: 16px;
            margin-bottom: 15px;
        }
        .link-container {
            display: flex;
            align-items: center;
            background-color: #2a2a2a;
            border: 1px solid #444444;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 20px;
            margin-left: 0;
            margin-right: 20px;
            width: 95%;
        }
        .link-input {
            width: 95%;
            background: transparent;
            border: none;
            color: #ffffff;
            font-size: 14px;
            outline: none;
            font-family: monospace;
        }

        .cta-button {
            background-color: #00d4aa;
            color: #000000;
            padding: 15px 30px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: bold;
            font-size: 16px;
            display: inline-block;
            margin-bottom: 20px;
        }
        .footer {
            color: #888888;
            font-size: 14px;
            text-align: center;
        }
        @media (max-width: 600px) {
            .container {
                padding: 10px;
            }
            .card {
                padding: 20px;
            }
            .title {
                font-size: 24px;
            }
            .qr-code {
                width: 150px;
                height: 150px;
            }
        }
    </style>
</head>
<body>
    <div class="container">

        
        <div class="card">
            
            <h2 class="success-title">Registration Successful!</h2>
            <p class="success-message">
                Thank you for registering, ${visitorName}!
            </p>
            <div class="verified-badge">Verified ✓</div>
            
            <div class="qr-section">
                <div class="qr-label">Your personal contact center QR code:</div>
                <div class="qr-code">
                    ${
                      qrCodeDataUrl && qrCodeDataUrl.startsWith("data:image/")
                        ? `<img src="cid:qrcode.png" alt="QR Code" style="width: 200px; height: 200px; display: block;" />`
                        : '<div style="width: 200px; height: 200px; background-color: #333; display: flex; align-items: center; justify-content: center; color: #666;">QR Code Not Available</div>'
                    }
                </div>
            </div>
            
            <div class="link-section">
                <div class="link-label">Your personal demo link:</div>
                <div class="link-container">
                    <input type="text" class="link-input" value="${demoPortalUrl}" readonly />
                    
                </div>
                <div class="expiration-info">
                    <p style="color: #888888; font-size: 12px; margin: 10px 0 0 0; text-align: center;">
                        ⏰ This private link will expire on ${formattedExpirationDate}.
                    </p>
                </div>
            </div>
            
            <a href="${demoPortalUrl}" class="cta-button">
                🚀 Access Your Contact Center
            </a>
            
            <div class="footer">
                Save this link and QR code for future access to your contact center.
            </div>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Send visitor registration confirmation email
 * @param {string} email - Visitor's email address
 * @param {Object} visitorData - Visitor data object
 * @param {string} baseUrl - Base URL for the demo portal
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendVisitorRegistrationEmail(
  email,
  visitorData,
  baseUrl
) {
  try {
    const { first_name, last_name, qr_code_data_url } = visitorData;
    const visitorName = first_name
      ? `${first_name}${last_name ? ` ${last_name}` : ""}`
      : "there";

    const subject = `Welcome to Telnyx Contact Center, ${visitorName}! 🎉`;
    const html = await generateRegistrationEmailHTML(visitorData, baseUrl);
    const text = `Thank you for registering to Telnyx Contact Center, ${visitorName}! 🎉\n\nVisit the link below to access your personalized demo experience:\n\n${baseUrl}/demo/${visitorData.unique_id}`;

    // Prepare inline attachments for QR code
    const options = {};
    if (qr_code_data_url && qr_code_data_url.startsWith("data:image/")) {
      // Extract base64 data from data URL
      const matches = qr_code_data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const contentType = matches[1];
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, "base64");

        options.inlineAttachments = [
          {
            data: buffer,
            filename: "qrcode.png",
            contentType: contentType,
            contentId: "qrcode",
          },
        ];

        adminRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      }
    }

    return await sendEmailNotification(email, subject, html, text, options);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Failed to send registration email",
    };
  }
}

/**
 * Get base URL for the application
 * @returns {string} Base URL
 */
export function getBaseUrl() {
  // In production, use the actual domain
  if (process.env.NODE_ENV === "production") {
    return process.env.APP_BASE_URL || "https://demo.telnyx.com";
  }

  // In development, use localhost
  return process.env.APP_BASE_URL || "http://localhost:3000";
}

/**
 * Generate HTML email template for password reset
 * @param {string} userName - User's name
 * @param {string} resetUrl - Password reset URL with token
 * @param {string} brandColor - Brand primary color hex (default #00BC8C)
 * @returns {string} HTML email content
 */
export function generatePasswordResetEmailHTML(userName, resetUrl, brandColor = "#00BC8C") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset Your Password - Telnyx Contact Center</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .header { background-color: ${brandColor}; padding: 36px 40px; text-align: center; }
    .header-icon { font-size: 40px; margin: 0 0 12px; }
    .header-title { color: #ffffff; font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
    .header-subtitle { color: rgba(255,255,255,0.85); font-size: 14px; margin: 6px 0 0; }
    .body { padding: 40px; }
    .greeting { font-size: 22px; font-weight: 600; color: #1a1a1a; margin: 0 0 16px; }
    .text { font-size: 15px; color: #555555; line-height: 1.6; margin: 0 0 24px; }
    .cta-wrapper { text-align: center; margin: 32px 0; }
    .cta-button { display: inline-block; background-color: ${brandColor}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 36px; border-radius: 8px; }
    .notice { font-size: 13px; color: #888888; margin: 24px 0 0; }
    .divider { border: none; border-top: 1px solid #eeeeee; margin: 32px 0; }
    .footer { padding: 24px 40px; background: #f9f9f9; text-align: center; }
    .footer-text { font-size: 12px; color: #aaaaaa; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <p class="header-icon">🔒</p>
      <p class="header-title">Password Reset</p>
      <p class="header-subtitle">Telnyx Contact Center</p>
    </div>
    <div class="body">
      <p class="greeting">Hi ${userName}! 👋</p>
      <p class="text">
        We received a request to reset your password for your <strong>Telnyx Contact Center</strong> account.
        Click the button below to choose a new password.
      </p>
      <div class="cta-wrapper">
        <a href="${resetUrl}" class="cta-button">Reset My Password</a>
      </div>
      <p class="notice">⏱ This link will expire in <strong>1 hour</strong> for security reasons.</p>
      <p class="notice">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
      <hr class="divider" />
      <p class="text" style="font-size:13px;color:#888">
        If the button above doesn't work, copy and paste this link into your browser:<br/>
        <a href="${resetUrl}" style="color:${brandColor};word-break:break-all;">${resetUrl}</a>
      </p>
    </div>
    <div class="footer">
      <p class="footer-text">
        Telnyx Contact Center &bull; Powered by Telnyx LLC<br/>
        This is an automated message, please do not reply.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send password reset email
 * @param {string} email - User's email address
 * @param {string} userName - User's name
 * @param {string} resetToken - Password reset token
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendPasswordResetEmail(email, userName, resetToken) {
  try {
    const baseUrl = getBaseUrl();
    const resetUrl = `${baseUrl}/reset-password/${resetToken}`;
    const brandColor = await getBrandPrimaryColor();
    const subject = "Reset Your Password - Telnyx Contact Center";
    const html = generatePasswordResetEmailHTML(userName, resetUrl, brandColor);
    const text = `Hi ${userName}, We received a request to reset your password. Visit this link to reset it: ${resetUrl} - This link will expire in 1 hour. If you didn't request this, please ignore this email.`;

    return await sendEmailNotification(email, subject, html, text);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Failed to send password reset email",
    };
  }
}

/**
 * Generate HTML email template for account activation
 * @param {string} userName - User's name
 * @param {string} activationUrl - Account activation URL with token
 * @param {string} brandColor - Brand primary color hex (default #00BC8C)
 * @returns {string} HTML email content
 */
export function generateActivationEmailHTML(userName, activationUrl, brandColor = "#00BC8C") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Activate Your Account - Telnyx Contact Center</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .header { background-color: ${brandColor}; padding: 36px 40px; text-align: center; }
    .header-icon { font-size: 40px; margin: 0 0 12px; }
    .header-title { color: #ffffff; font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
    .header-subtitle { color: rgba(255,255,255,0.85); font-size: 14px; margin: 6px 0 0; }
    .body { padding: 40px; }
    .greeting { font-size: 22px; font-weight: 600; color: #1a1a1a; margin: 0 0 16px; }
    .text { font-size: 15px; color: #555555; line-height: 1.6; margin: 0 0 24px; }
    .cta-wrapper { text-align: center; margin: 32px 0; }
    .cta-button { display: inline-block; background-color: ${brandColor}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 36px; border-radius: 8px; }
    .notice { font-size: 13px; color: #888888; margin: 24px 0 0; }
    .divider { border: none; border-top: 1px solid #eeeeee; margin: 32px 0; }
    .footer { padding: 24px 40px; background: #f9f9f9; text-align: center; }
    .footer-text { font-size: 12px; color: #aaaaaa; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <p class="header-icon">✉️</p>
      <p class="header-title">Welcome to Contact Center</p>
      <p class="header-subtitle">Telnyx Contact Center</p>
    </div>
    <div class="body">
      <p class="greeting">Hi ${userName}! 👋</p>
      <p class="text">
        Thank you for signing up for <strong>Telnyx Contact Center</strong>!
        To complete your registration and get started, please activate your account by clicking the button below.
      </p>
      <div class="cta-wrapper">
        <a href="${activationUrl}" class="cta-button">Activate My Account</a>
      </div>
      <p class="notice">⏱ This activation link will expire in <strong>24 hours</strong>.</p>
      <p class="notice">If you didn't create an account with Telnyx Contact Center, you can safely ignore this email.</p>
      <hr class="divider" />
      <p class="text" style="font-size:13px;color:#888">
        If the button above doesn't work, copy and paste this link into your browser:<br/>
        <a href="${activationUrl}" style="color:${brandColor};word-break:break-all;">${activationUrl}</a>
      </p>
    </div>
    <div class="footer">
      <p class="footer-text">
        Telnyx Contact Center &bull; Powered by Telnyx LLC<br/>
        This is an automated message, please do not reply.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send account activation email
 * @param {string} email - User's email address
 * @param {string} userName - User's name
 * @param {string} activationToken - Account activation token
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendActivationEmail(email, userName, activationToken) {
  try {
    const baseUrl = getBaseUrl();
    const activationUrl = `${baseUrl}/activate/${activationToken}`;
    const brandColor = await getBrandPrimaryColor();
    const subject = `Activate Your Account - Telnyx Contact Center 🎉`;
    const html = generateActivationEmailHTML(userName, activationUrl, brandColor);
    const text = `Hi ${userName}, Welcome to Telnyx Contact Center! Please activate your account by visiting: ${activationUrl} - This link will expire in 24 hours. If you didn't create this account, please ignore this email.`;

    return await sendEmailNotification(email, subject, html, text);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Failed to send activation email",
    };
  }
}

/**
 * Generate HTML email template for visitor activation
 * @param {string} visitorName - Visitor's name
 * @param {string} activationUrl - Activation URL with token
 * @returns {string} HTML email content
 */
export function generateVisitorActivationEmailHTML(visitorName, activationUrl) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email - Telnyx Contact Center</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background-color: #000000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #ffffff;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .card {
            background-color: #1a1a1a;
            border-radius: 12px;
            padding: 30px;
            text-align: center;
        }
        .email-icon {
            width: 60px;
            height: 60px;
            margin: 0 auto 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
        }
        .title {
            font-size: 24px;
            font-weight: bold;
            color: #ffffff;
            margin-bottom: 10px;
        }
        .message {
            color: #cccccc;
            margin-bottom: 20px;
            line-height: 1.5;
        }
        .cta-button {
            background-color: #00d4aa;
            color: #000000;
            padding: 15px 30px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: bold;
            font-size: 16px;
            display: inline-block;
            margin: 20px 0;
        }
        .link-section {
            margin: 30px 0;
        }
        .link-label {
            color: #ffffff;
            font-size: 14px;
            margin-bottom: 10px;
        }
        .link-container {
            background-color: #2a2a2a;
            border: 1px solid #444444;
            border-radius: 8px;
            padding: 12px;
            margin: 10px auto;
            max-width: 90%;
            word-break: break-all;
        }
        .link-text {
            color: #00d4aa;
            font-size: 12px;
            font-family: monospace;
        }
        .footer {
            color: #888888;
            font-size: 12px;
            text-align: center;
            margin-top: 20px;
            line-height: 1.5;
        }
        @media (max-width: 600px) {
            .container {
                padding: 10px;
            }
            .card {
                padding: 20px;
            }
            .title {
                font-size: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="email-icon">✉️</div>
            <h2 class="title">Verify Your Email Address</h2>
            <p class="message">
                Hi ${visitorName},<br><br>
                Thank you for registering for the Telnyx Contact Center! To complete your registration
                and access your personalized demo experience, please verify your email address by clicking the button below:
            </p>
            
            <a href="${activationUrl}" class="cta-button">
                🚀 Verify Email & Access Demo
            </a>
            
            <div class="link-section">
                <div class="link-label">Or copy and paste this link in your browser:</div>
                <div class="link-container">
                    <div class="link-text">${activationUrl}</div>
                </div>
            </div>
            
            <div class="footer">
                If you didn't register for the Telnyx Contact Center, you can safely ignore this email.<br><br>
                This verification link will expire in 24 hours.
            </div>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Send visitor activation email
 * @param {string} email - Visitor's email address
 * @param {string} visitorName - Visitor's name
 * @param {string} activationToken - Activation token
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendVisitorActivationEmail(
  email,
  visitorName,
  activationToken
) {
  try {
    const baseUrl = getBaseUrl();
    const activationUrl = `${baseUrl}/demo/activate/${activationToken}`;
    const subject = `Verify Your Email - Telnyx Contact Center 🎉`;
    const html = generateVisitorActivationEmailHTML(visitorName, activationUrl);
    const text = `Hi ${visitorName}, Welcome to Telnyx Contact Center! Please verify your email address by visiting: ${activationUrl} - This link will expire in 24 hours. If you didn't register for the demo, please ignore this email.`;

    return await sendEmailNotification(email, subject, html, text);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Failed to send visitor activation email",
    };
  }
}

/**
 * Generate HTML for user invite email
 * @param {object} user - User object
 * @param {string} inviteUrl - Full invite URL
 * @param {string} brandColor - Brand primary color hex (default #00BC8C)
 * @returns {string} HTML email content
 */
function generateUserInviteEmailHTML(user, inviteUrl, brandColor = "#00BC8C") {
  const firstName = user.first_name || user.firstName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to Telnyx Contact Center</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .header { background-color: ${brandColor}; padding: 36px 40px; text-align: center; }
    .header-title { color: #ffffff; font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
    .header-subtitle { color: rgba(255,255,255,0.85); font-size: 14px; margin: 6px 0 0; }
    .body { padding: 40px; }
    .greeting { font-size: 22px; font-weight: 600; color: #1a1a1a; margin: 0 0 16px; }
    .text { font-size: 15px; color: #555555; line-height: 1.6; margin: 0 0 24px; }
    .cta-wrapper { text-align: center; margin: 32px 0; }
    .cta-button { display: inline-block; background-color: ${brandColor}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 36px; border-radius: 8px; }
    .notice { font-size: 13px; color: #888888; margin: 24px 0 0; }
    .divider { border: none; border-top: 1px solid #eeeeee; margin: 32px 0; }
    .footer { padding: 24px 40px; background: #f9f9f9; text-align: center; }
    .footer-text { font-size: 12px; color: #aaaaaa; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <p class="header-title">Telnyx Contact Center</p>
      <p class="header-subtitle">You have been invited</p>
    </div>
    <div class="body">
      <p class="greeting">Hi ${firstName}! 👋</p>
      <p class="text">
        An administrator has created an account for you on <strong>Telnyx Contact Center</strong>.
        Click the button below to set your password and get started.
      </p>
      <div class="cta-wrapper">
        <a href="${inviteUrl}" class="cta-button">Set My Password</a>
      </div>
      <p class="notice">⏱ This invitation expires in <strong>7 days</strong>.</p>
      <p class="notice">If you did not expect this invitation, you can safely ignore this email.</p>
      <hr class="divider" />
      <p class="text" style="font-size:13px;color:#888">
        If the button above doesn't work, copy and paste this link into your browser:<br/>
        <a href="${inviteUrl}" style="color:${brandColor};word-break:break-all;">${inviteUrl}</a>
      </p>
    </div>
    <div class="footer">
      <p class="footer-text">
        Telnyx Contact Center &bull; Powered by Telnyx LLC<br/>
        This is an automated message, please do not reply.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send user invite email
 * @param {object} user - User object with first_name, last_name, username fields
 * @param {string} inviteUrl - Full invite URL
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendUserInviteEmail(user, inviteUrl) {
  try {
    const firstName = user.first_name || user.firstName || "there";
    const lastName = user.last_name || user.lastName || "";
    const email = user.username || user.email;

    if (!email) {
      return { success: false, error: "No email address for user" };
    }

    const brandColor = await getBrandPrimaryColor();
    const subject = "You're invited to Telnyx Contact Center";
    const html = generateUserInviteEmailHTML(user, inviteUrl, brandColor);
    const text = `Hi ${firstName},\n\nAn administrator has created an account for you on Telnyx Contact Center.\n\nClick the link below to set your password and get started:\n${inviteUrl}\n\nThis invitation expires in 7 days.\n\nIf you did not expect this, you can safely ignore this email.`;

    return await sendEmailNotification(email, subject, html, text);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return {
      success: false,
      error: error.message || "Failed to send invite email",
    };
  }
}
