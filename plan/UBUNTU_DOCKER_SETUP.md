# Ubuntu Docker Setup Commands

Run these commands on your fresh Ubuntu EC2 instance to update the system and install Docker.

## 1. Update System Packages

```bash
# Update package list
sudo apt update

# Upgrade all installed packages to latest versions
sudo apt upgrade -y

# Install essential build tools and dependencies
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
```

## 2. Install Docker

```bash
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

# Verify Docker installation
sudo docker --version
sudo docker compose version
```

## 3. Configure Docker (Optional but Recommended)

```bash
# Add your user to docker group (replace 'ubuntu' with your username if different)
sudo usermod -aG docker ubuntu

# Enable Docker to start on boot
sudo systemctl enable docker
sudo systemctl start docker

# Verify Docker is running
sudo systemctl status docker
```

## 4. Configure Firewall (if UFW is enabled)

```bash
# Allow SSH (if not already allowed)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow application port (default 3000)
sudo ufw allow 3000/tcp

# Enable firewall
sudo ufw --force enable

# Check firewall status
sudo ufw status
```

## 5. Verify Installation

```bash
# Test Docker with hello-world
sudo docker run hello-world

# Check Docker Compose
sudo docker compose version
```

## Notes

- After adding your user to the docker group, you may need to log out and log back in for the changes to take effect
- If you're using a different user than 'ubuntu', replace it in the usermod command
- For production, consider setting up a reverse proxy (nginx) in front of your application
- Make sure your EC2 security group allows inbound traffic on ports 22 (SSH), 80 (HTTP), 443 (HTTPS), and 3000 (App)
