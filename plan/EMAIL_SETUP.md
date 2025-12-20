# Email Notifications Setup

The application uses **Mailgun** to send email notifications for:

- Account activation emails (when users sign up)
- Password reset emails
- Other transactional emails

## Required Environment Variables

Add these to your `.env.local` file:

```env
# ===== EMAIL CONFIGURATION (Mailgun) =====
EMAIL_API_KEY=your_mailgun_api_key_here
EMAIL_DOMAIN=your_mailgun_domain_here
EMAIL_FROM=noreply@yourdomain.com
APP_BASE_URL=http://localhost:3000
```

### Environment Variable Details

1. **`EMAIL_API_KEY`** (Required)

   - Your Mailgun API key
   - Get it from: https://app.mailgun.com/app/account/security/api_keys
   - Format: `key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

2. **`EMAIL_DOMAIN`** (Required)

   - Your Mailgun domain (e.g., `mg.yourdomain.com` or `sandbox-xxx.mailgun.org` for testing)
   - Get it from: https://app.mailgun.com/app/sending/domains
   - For testing, you can use Mailgun's sandbox domain

3. **`EMAIL_FROM`** (Required)

   - The "from" email address for all emails
   - Must be a verified sender in Mailgun
   - Format: `noreply@yourdomain.com` or `Name <email@domain.com>`

4. **`APP_BASE_URL`** (Required)
   - Base URL of your application
   - Used to generate activation and password reset links in emails
   - For local dev: `http://localhost:3000`
   - For production: `https://yourdomain.com`
   - Falls back to `http://localhost:3000` in development if not set

## Getting Started with Mailgun

### 1. Create a Mailgun Account

- Sign up at https://www.mailgun.com/
- Free tier includes 5,000 emails/month for 3 months

### 2. Verify Your Domain (Production)

- Go to Sending → Domains
- Add your domain
- Follow DNS verification steps
- Once verified, use your domain in `EMAIL_DOMAIN`

### 3. Use Sandbox Domain (Testing)

- Mailgun provides a sandbox domain for testing
- Format: `sandbox-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.mailgun.org`
- You can only send to authorized recipients (add them in Mailgun dashboard)
- Use this for local development

### 4. Get Your API Key

- Go to Settings → API Keys
- Copy your Private API key
- Add it to `.env.local` as `EMAIL_API_KEY`

### 5. Authorize Recipients (Sandbox Only)

- If using sandbox domain, go to Sending → Authorized Recipients
- Add email addresses you want to test with
- Mailgun will send verification emails to these addresses

## Example `.env.local` Configuration

```env
# For local development with Mailgun sandbox
EMAIL_API_KEY=key-1234567890abcdef1234567890abcdef
EMAIL_DOMAIN=sandbox-1234567890abcdef1234567890abcdef.mailgun.org
EMAIL_FROM=noreply@sandbox-1234567890abcdef1234567890abcdef.mailgun.org
APP_BASE_URL=http://localhost:3000

# For production with verified domain
EMAIL_API_KEY=key-1234567890abcdef1234567890abcdef
EMAIL_DOMAIN=mg.yourdomain.com
EMAIL_FROM=noreply@yourdomain.com
APP_BASE_URL=https://yourdomain.com
```

## How It Works

1. **Account Activation**: When a user signs up, an activation email is sent with a link to `/activate/[token]`
2. **Password Reset**: When a user requests password reset, an email is sent with a link to `/reset-password/[token]`
3. **Email Links**: All links in emails use `APP_BASE_URL` to construct full URLs

## Testing Email Functionality

1. Set up Mailgun with sandbox domain
2. Add your test email to authorized recipients
3. Sign up a new account with that email
4. Check your inbox for the activation email
5. Click the activation link to verify it works

## Troubleshooting

### Emails Not Sending

- Check that all three required env vars are set
- Verify your Mailgun API key is correct
- Ensure your domain is verified (or use sandbox)
- Check Mailgun dashboard for error logs

### Links Not Working

- Verify `APP_BASE_URL` matches your actual application URL
- For local dev, use `http://localhost:3000`
- For production, use your full domain with `https://`

### Sandbox Domain Issues

- Remember: sandbox domains can only send to authorized recipients
- Add test emails to authorized recipients in Mailgun dashboard
- Verify the test email addresses in Mailgun

## Security Notes

- Never commit `.env.local` to version control
- Keep your Mailgun API key secret
- Use different API keys for development and production
- Rotate API keys periodically
