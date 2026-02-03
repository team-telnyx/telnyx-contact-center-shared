# Multi-Repo Sync Setup Guide

This repository is configured to automatically sync to two child repositories:

- `telnyx-contact-center-gmr`
- `telnyx-contact-center-ttec`

## How It Works

### 1. Local Multiple Push URLs (Immediate)

Your local git is configured to push to all three repositories simultaneously when you run:

```bash
git push origin main
```

This works immediately without any additional setup.

### 2. GitHub Actions (Automatic Cloud Sync)

A GitHub Actions workflow (`.github/workflows/sync.yml`) automatically syncs to child repos whenever:

- Code is pushed to `main` or `master` branch
- The workflow is manually triggered from the GitHub Actions tab

## Prerequisites

**⚠️ IMPORTANT: Child repositories must exist on GitHub before syncing can work!**

The child repos (`telnyx-contact-center-gmr` and `telnyx-contact-center-ttec`) need to be created first. You can:

1. **Create them manually** via GitHub web interface:

   - Go to https://github.com/new
   - Repository name: `telnyx-contact-center-gmr` (or `telnyx-contact-center-ttec`)
   - Owner: `team-telnyx`
   - Choose visibility (private/public)
   - **Do NOT** initialize with README, .gitignore, or license (we'll push the full code)
   - Click "Create repository"

2. **Use the helper script** (if you have GitHub CLI installed):
   ```bash
   chmod +x scripts/create-child-repos.sh
   ./scripts/create-child-repos.sh
   ```

## Setup Instructions

### Step 1: Create GitHub Personal Access Token

1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a descriptive name (e.g., "Multi-repo sync token")
4. Select the `repo` scope (full control of private repositories)
5. Click "Generate token"
6. **Copy the token immediately** - you won't be able to see it again!

### Step 2: Add Secret to Mother Repo

1. Go to your mother repo: `https://github.com/team-telnyx/telnyx-contact-center`
2. Navigate to: Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Name: `REPO_TOKEN`
5. Value: Paste your Personal Access Token
6. Click "Add secret"

### Step 3: Verify Setup

1. Make a test commit and push to `main`:

   ```bash
   git commit --allow-empty -m "Test sync"
   git push origin main
   ```

2. Check the GitHub Actions tab in your mother repo
3. You should see a "Sync to child repos" workflow running
4. Once complete, verify the child repos have been updated

## Troubleshooting

### GitHub Actions Not Running

- Ensure the `REPO_TOKEN` secret is set correctly
- Check that the workflow file exists at `.github/workflows/sync.yml`
- Verify the token has `repo` permissions

### Push Fails Locally

- **Most common issue**: Child repos don't exist yet. Create them first (see Prerequisites above)
- Ensure child repos exist and you have push access
- Check that the remote URLs are correct: `git remote -v`
- If using SSH, ensure your SSH keys are set up for GitHub
- If repos don't exist yet, you can temporarily remove child repo push URLs:
  ```bash
  git remote set-url --delete --push origin https://github.com/team-telnyx/telnyx-contact-center-gmr.git
  git remote set-url --delete --push origin https://github.com/team-telnyx/telnyx-contact-center-ttec.git
  ```
  Then re-add them after creating the repos.

### Branch Name Mismatch

The workflow tries both `main` and `master` branches. If your child repos use a different default branch, update `.github/workflows/sync.yml` accordingly.

## Removing Local Push URLs (Optional)

Once GitHub Actions is working reliably, you can remove the local multiple push URLs:

```bash
# Reset origin to just the mother repo
git remote set-url origin https://github.com/team-telnyx/telnyx-contact-center.git
git remote set-url --delete --push origin https://github.com/team-telnyx/telnyx-contact-center-gmr.git
git remote set-url --delete --push origin https://github.com/team-telnyx/telnyx-contact-center-ttec.git
```

This way, all syncing happens automatically via GitHub Actions, and you don't need local configuration.
