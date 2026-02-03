#!/bin/bash

# Script to create and initialize child repositories for multi-repo sync
# Usage: ./scripts/create-child-repos.sh

set -e

MOTHER_REPO="https://github.com/team-telnyx/telnyx-contact-center.git"
CHILD_REPOS=(
  "telnyx-contact-center-gmr"
  "telnyx-contact-center-ttec"
)

echo "🚀 Creating child repositories..."
echo ""

for CHILD_REPO in "${CHILD_REPOS[@]}"; do
  echo "📦 Creating $CHILD_REPO..."
  
  # Check if repo already exists locally
  if [ -d "../$CHILD_REPO" ]; then
    echo "   ⚠️  Directory ../$CHILD_REPO already exists, skipping..."
    continue
  fi
  
  # Create the repo on GitHub (requires GitHub CLI)
  if command -v gh &> /dev/null; then
    echo "   Creating repository on GitHub..."
    gh repo create "team-telnyx/$CHILD_REPO" --private --source=. --remote=origin --push || {
      echo "   ⚠️  Failed to create repo via GitHub CLI. Please create it manually:"
      echo "      https://github.com/new?name=$CHILD_REPO&owner=team-telnyx"
    }
  else
    echo "   ⚠️  GitHub CLI (gh) not found. Please create the repository manually:"
    echo "      https://github.com/new?name=$CHILD_REPO&owner=team-telnyx"
    echo "   Then run this script again to initialize it."
    read -p "   Press Enter after you've created the repo..."
  fi
  
  echo "   ✅ $CHILD_REPO ready"
  echo ""
done

echo "✨ Child repositories setup complete!"
echo ""
echo "Next steps:"
echo "1. Ensure the repos exist on GitHub"
echo "2. Add REPO_TOKEN secret to the mother repo (see .github/SYNC_SETUP.md)"
echo "3. Test with: git push origin master"
