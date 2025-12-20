#!/bin/bash

# Ubuntu Docker Installation Script
# Run this script on your fresh Ubuntu EC2 instance to install Docker and dependencies

set -e

echo "🚀 Starting Docker installation on Ubuntu..."

# 1. Update System Packages
echo "📦 Updating system packages..."
sudo apt update
sudo apt upgrade -y

echo "📦 Installing essential build tools and dependencies..."
sudo apt install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    software-properties-common \
    git

# Clean up unnecessary packages
sudo apt autoremove -y
sudo apt autoclean

# 2. Install Docker
echo "🐳 Installing Docker..."

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Set up Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update package list again
sudo apt update

# Install Docker Engine, CLI, and Docker Compose plugin
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3. Configure Docker
echo "⚙️  Configuring Docker..."

# Add current user to docker group (detect username automatically)
CURRENT_USER=${SUDO_USER:-$USER}
if [ "$CURRENT_USER" != "root" ]; then
    echo "👤 Adding user '$CURRENT_USER' to docker group..."
    sudo usermod -aG docker "$CURRENT_USER"
    echo "⚠️  Note: You may need to log out and log back in for docker group changes to take effect"
fi

# Enable Docker to start on boot
sudo systemctl enable docker
sudo systemctl start docker

# 4. Configure Firewall (if UFW is enabled)
echo "🔥 Configuring firewall..."
if command -v ufw &> /dev/null; then
    # Allow SSH (if not already allowed)
    sudo ufw allow 22/tcp
    
    # Allow HTTP and HTTPS
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    
    # Allow application port (default 3000)
    sudo ufw allow 3000/tcp
    
    # Enable firewall
    sudo ufw --force enable
    
    echo "✅ Firewall configured"
else
    echo "⚠️  UFW not found, skipping firewall configuration"
fi

# 5. Verify Installation
echo "🔍 Verifying installation..."
sudo docker --version
sudo docker compose version

# Test Docker with hello-world
echo "🧪 Testing Docker with hello-world..."
sudo docker run hello-world

echo ""
echo "✅ Docker installation completed successfully!"
echo ""
echo "⚠️  IMPORTANT: Docker Group Configuration"
if [ "$CURRENT_USER" != "root" ] && [ -n "$CURRENT_USER" ]; then
    echo "   Your user '$CURRENT_USER' has been added to the docker group."
    echo "   ⚠️  YOU MUST LOG OUT AND LOG BACK IN for this to take effect!"
    echo "   Without logging out/in, you'll get 'permission denied' errors."
    echo ""
    echo "   To verify after logout/login, run: docker run hello-world"
fi
echo ""
echo "📝 Next steps:"
echo "  1. ⚠️  LOG OUT AND LOG BACK IN (required for docker group)"
echo "  2. Clone your repository: git clone <your-repo-url>"
echo "  3. Navigate to docker directory: cd telnyx-contact-center/docker"
echo "  4. Create .env file in docker/production/ with your configuration"
echo "  5. Run deployment: ./deploy.sh production"
echo ""
echo "📋 Useful commands:"
echo "  - Check Docker status: sudo systemctl status docker"
echo "  - View Docker logs: sudo journalctl -u docker"
echo "  - Test Docker access: docker run hello-world"
echo "  - If permission denied, run with sudo: sudo docker run hello-world"
