locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.tags)
}

# ===========================================================================
# VNet — one dedicated VNet + subnets per deployment, no sharing with
# anything else in the resource group. Mirrors the AWS/GCP roots'
# per-deployment network design.
# ===========================================================================

resource "azurerm_virtual_network" "main" {
  name                = "${local.name_prefix}-vnet"
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = [var.vnet_cidr]
  tags                = local.common_tags
}

resource "azurerm_subnet" "app" {
  name                 = "${local.name_prefix}-app-subnet"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.subnet_cidr]
}

# ===========================================================================
# Delegated subnet for Postgres Flexible Server — the Azure equivalent of
# GCP's Private Services Access peering (cc-network-gcp's
# google_service_networking_connection). Flexible Server with VNet
# integration (private access, no public endpoint — matching AWS's RDS in a
# private subnet and GCP's Cloud SQL private IP) REQUIRES its own delegated
# subnet: `Microsoft.DBforPostgreSQL/flexibleServers` is the only workload
# allowed in it, enforced by the delegation block below. This is a hard
# Azure API requirement, not a config choice — Flexible Server creation
# fails outright without a properly delegated subnet.
# ===========================================================================

resource "azurerm_subnet" "db" {
  name                 = "${local.name_prefix}-db-subnet"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_cidr, 4, 1)]

  delegation {
    name = "postgres-flexible-server-delegation"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Private DNS zone Flexible Server uses to resolve its own private-access
# hostname inside the VNet — required alongside the delegated subnet
# whenever `private_dns_zone_id` is set on azurerm_postgresql_flexible_server
# (see cc-database-azure). Must use the exact
# "private.postgres.database.azure.com" zone name Azure's provider expects.
resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = var.resource_group_name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${local.name_prefix}-pg-dns-link"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

# ===========================================================================
# NETWORK SECURITY GROUP — attached to the app subnet, plays the AWS
# Security Group / GCP firewall-rule role. Azure NSGs are a single resource
# with a list of prioritized rules rather than one-rule-per-resource, so
# this module models each logical rule as its own azurerm_network_security_rule
# entry to keep the same one-concern-per-resource shape as the AWS/GCP
# modules for readability and count-gating.
# ===========================================================================

resource "azurerm_network_security_group" "app" {
  name                = "${local.name_prefix}-app-nsg"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.common_tags
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# SSH — only opened when the operator explicitly supplied CIDRs (empty by
# default). The wizard's primary remote-exec path is `az vm run-command
# invoke`, which needs no open port 22 at all — same "no SSH keys, ever"
# posture as AWS's SSM RunCommand and GCP's IAP tunnel. See variables.tf's
# admin_ssh_source_ranges doc for why Azure has no equivalent
# always-on-proxy CIDR the way AWS/GCP do.
resource "azurerm_network_security_rule" "allow_ssh" {
  count                       = length(var.admin_ssh_source_ranges) > 0 ? 1 : 0
  name                        = "allow-ssh"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefixes     = var.admin_ssh_source_ranges
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.app.name
}

# App ports, direct — only when there is no Application Gateway in front
# (lb_enabled=false, Phase 1/2 default). Mirrors the AWS root's
# alb_enabled-gated SG rule and the GCP root's lb_enabled-gated firewall
# rule exactly.
resource "azurerm_network_security_rule" "allow_app_ports" {
  count                       = var.lb_enabled ? 0 : 1
  name                        = "allow-app-ports"
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = [tostring(var.app_port), tostring(var.streaming_ws_port)]
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.app.name
}

# Application Gateway health-probe + proxied traffic — Azure's Application
# Gateway lives inside the SAME VNet (in its own dedicated subnet, unlike
# AWS ALB/GCP LB which are fully managed and reach backends over published
# external IP ranges), so instead of an external source-range allowlist
# this rule scopes to the gateway's own subnet CIDR. See
# cc-compute-single-azure for the gateway subnet definition.
#
# PRIORITY NOTE: on a live e2e test, Azure auto-provisioned an UNMANAGED
# rule literally named "SSH" at priority 120 on this exact NSG — almost
# certainly Microsoft Defender for Cloud's Just-in-Time VM access feature
# (enabled at the subscription level, outside this module's control)
# reacting to an operator's `az login`/portal session. That collided with
# this rule's own priority 120 ("SecurityRuleConflict: Security rule SSH
# conflicts with rule allow-appgw"), and `terraform apply` failed outright
# — Terraform has no state entry for a rule it never created, so it can't
# resolve the conflict itself. If this recurs, either delete the foreign
# rule (`az network nsg rule delete --nsg-name <nsg> --name SSH`) before
# re-applying, or disable Defender's JIT VM access for this subscription/
# resource group. Not fixable purely inside this module: Terraform cannot
# preemptively reserve a priority another control plane might claim later.
resource "azurerm_network_security_rule" "allow_appgw" {
  count                       = var.lb_enabled ? 1 : 0
  name                        = "allow-appgw"
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = [tostring(var.app_port), tostring(var.streaming_ws_port)]
  source_address_prefix       = cidrsubnet(var.vnet_cidr, 4, 2)
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.app.name
}

resource "azurerm_network_security_rule" "allow_portainer_agent" {
  count                       = var.portainer_agent_enabled && length(var.portainer_server_cidrs) > 0 ? 1 : 0
  name                        = "allow-portainer-agent"
  priority                    = 130
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = tostring(var.portainer_agent_port)
  source_address_prefixes     = var.portainer_server_cidrs
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.app.name
}
