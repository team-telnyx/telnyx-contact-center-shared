# Authentication Setup

This document describes the authentication system implemented in the Telnyx Contact Center application.

## Features

✅ **Sign Up** - User registration with email verification
✅ **Sign In** - Email/password and OAuth authentication
✅ **Password Reset** - Forgot password and reset functionality
✅ **Change Password** - Update password from profile page
✅ **Google Authentication** - OAuth integration with Google
✅ **NextAuth.js** - Session management and JWT tokens

## Pages

- `/signin` - Sign in page with credentials and Google OAuth
- `/signup` - Sign up page with email verification
- `/forgot-password` - Request password reset
- `/reset-password/[token]` - Reset password with token
- `/profile` - User profile with password change option

## API Routes

### Authentication

- `/api/auth/[...nextauth]` - NextAuth.js handler (Google OAuth, credentials)
- `/api/auth/me` - Get current authenticated user
- `/api/auth/signin` - Sign in with credentials
- `/api/auth/signup` - User registration
- `/api/auth/logout` - Logout
- `/api/auth/forgot-password` - Request password reset
- `/api/auth/reset-password` - Reset password with token
- `/api/auth/update-password` - Change password (authenticated)
- `/api/auth/activate` - Activate account with token
- `/api/auth/google-signin` - Google OAuth callback
- `/api/auth/refresh` - Refresh access token

### User Profile

- `/api/user/profile` - Get/update user profile
- `/api/user/auth-methods` - Get authentication methods (password, Google, etc.)
- `/api/user/status-stream` - Server-Sent Events for real-time status updates

## Database Tables

### Authentication Tables (NextAuth)

- `auth_users` - NextAuth user records
- `auth_accounts` - OAuth account links
- `auth_sessions` - User sessions
- `auth_verification_tokens` - Email verification tokens

### User Tables

- `users` - Main user table with contact center configuration
- `domains` - Allowed email domains for registration

## Environment Variables

Required for authentication:

```env
# NextAuth Configuration
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your_secret_here  # Generate with: openssl rand -base64 32
AUTH_SECRET=your_secret_here  # Same as NEXTAUTH_SECRET

# Google OAuth (for Google sign-in)
GOOGLE_ID=your_google_client_id
GOOGLE_SECRET=your_google_client_secret

# Optional: reCAPTCHA (for signup protection)
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=your_recaptcha_site_key
RECAPTCHA_SECRET_KEY=your_recaptcha_secret_key

# Email Configuration (for activation/reset emails)
EMAIL_API_KEY=your_mailgun_api_key
EMAIL_DOMAIN=your_mailgun_domain
EMAIL_FROM=noreply@yourdomain.com
```

## Setup Instructions

1. **Set up environment variables:**

   ```bash
   cp .env.example .env.local
   # Edit .env.local with your credentials
   ```

2. **Initialize database:**

   ```bash
   yarn ensure:pg
   ```

3. **Add allowed email domains:**

   ```sql
   INSERT INTO domains (id, domain, active)
   VALUES (gen_random_uuid()::text, 'yourdomain.com', true);
   ```

4. **Configure Google OAuth:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create OAuth 2.0 credentials
   - Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
   - Add `GOOGLE_ID` and `GOOGLE_SECRET` to `.env.local`

## Usage

### Sign Up

1. Navigate to `/signup`
2. Fill in email, password, name, and mobile
3. Click "Create account"
4. Check email for activation link
5. Click activation link to verify account

### Sign In

1. Navigate to `/signin`
2. Enter email and password, OR
3. Click "Sign in with Google" for OAuth

### Password Reset

1. Navigate to `/forgot-password`
2. Enter email address
3. Check email for reset link
4. Click link and set new password

### Change Password

1. Navigate to `/profile`
2. Go to "Security" tab
3. Enter current and new password
4. Click "Update Password"

## Security Features

- Password hashing with PBKDF2 (25,000 iterations)
- Email verification required for new accounts
- Domain whitelist for email registration
- reCAPTCHA v3 protection (optional)
- JWT tokens for API authentication
- Secure session management with NextAuth

## Notes

- Email domain validation: Only emails from domains in the `domains` table can register
- Activation tokens expire after 24 hours
- Password reset tokens expire after 1 hour
- Google OAuth users are automatically verified
