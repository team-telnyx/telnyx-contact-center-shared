# Deploy — Telnyx Contact Center Deployment Wizard (`cc`)

`./deploy/cc` is a single, self-contained CLI that takes Contact Center from
zero to a running, Telnyx-wired deployment — on your laptop via Docker, or on
AWS / Azure / GCP via Terraform — through one interactive wizard. It also
manages the full day-2 lifecycle: status, logs, updates, Telnyx resource
repair, and teardown.

This document is the complete reference for the wizard: every command, every
target, every menu choice, and what happens under the hood. For a quick
start, see the [top-level README](../README.md#deployment-wizard-deploycc).

---

## Table of contents

- [Quick start](#quick-start)
- [How the wizard works](#how-the-wizard-works)
- [Commands](#commands)
  - [`cc up`](#cc-up)
  - [`cc doctor`](#cc-doctor)
  - [`cc status`](#cc-status)
  - [`cc logs`](#cc-logs)
  - [`cc update`](#cc-update)
  - [`cc telnyx`](#cc-telnyx)
  - [`cc destroy`](#cc-destroy)
  - [`cc clean`](#cc-clean)
- [Deployment targets](#deployment-targets)
  - [Local (Docker)](#local-docker)
  - [AWS](#aws)
  - [GCP](#gcp)
  - [Azure](#azure)
- [Wizard steps in detail](#wizard-steps-in-detail)
- [Sizing](#sizing)
- [Non-interactive mode (CI, demos, scripted re-install)](#non-interactive-mode-ci-demos-scripted-re-install)
- [Webhook tunnels (Local target only)](#webhook-tunnels-local-target-only)
- [Persistent state (`.cc-state.json`)](#persistent-state-cc-statejson)
- [File layout](#file-layout)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
git clone https://github.com/team-telnyx/telnyx-contact-center.git
cd telnyx-contact-center
./deploy/cc up          # walks you through everything, interactively
```

First run installs the wizard's own isolated Node dependency tree
(`deploy/cli/node_modules`, via `npm install` — never touches the main app's
`yarn.lock`), then launches the wizard. Requires Node.js >= 20.

---

## How the wizard works

`cc up` runs a linear sequence of steps (see
[Wizard steps in detail](#wizard-steps-in-detail)). Every step's answer is
persisted to `deploy/.cc-state.json` as soon as it's given, so:

- **Nothing is created before you've answered every prompt and reached the
  provisioning step** — the intro screen says exactly this, and it's true:
  Telnyx resources, cloud infrastructure, and containers are all created
  only after consent + target + size + region + params + preflight all pass.
- **Ctrl-C or a crash is always resumable.** Re-run `./deploy/cc up` and the
  wizard detects an incomplete deployment (consent given, but the `summary`
  step never completed) and offers to resume from the next incomplete step,
  reusing every answer you already gave instead of re-asking.
- Every external write (Telnyx API calls, `terraform apply`, `docker compose
  up`) is idempotent where technically possible — Telnyx resources are
  find-by-name upserts, so a resumed or re-run bootstrap step never
  duplicates a voice app, SIP connection, or phone number.

---

## Commands

### `cc up`

```bash
./deploy/cc up
./deploy/cc up --non-interactive --config deploy/cc.answers.json
```

Runs (or resumes) the full interactive deployment wizard. See
[Wizard steps in detail](#wizard-steps-in-detail) for what each step asks,
and [Non-interactive mode](#non-interactive-mode-ci-demos-scripted-re-install)
for scripted/CI runs.

### `cc doctor`

```bash
./deploy/cc doctor
```

Runs every preflight check for the current (or a not-yet-started) target —
Docker, Docker Compose, ports, `psql`, Telnyx API key validity, Telnyx
account balance, `cloudflared`, and for cloud targets: Terraform version,
provider CLI (`aws`/`gcloud`/`az`) presence and auth, IAM/quota checks. **No
changes are made** — it's a pure read-only diagnostic, useful before your
first `cc up` or when something in a later step failed and you want to
re-verify your environment without re-running the whole wizard.

If a `TELNYX_API_KEY` env var isn't set, `doctor` prompts for one on a TTY
(Enter to skip that check) or just skips it with a hint in a non-TTY
context.

### `cc status`

```bash
./deploy/cc status
```

- **Local target:** shows `docker compose ps` output for the stack.
- **AWS / GCP / Azure:** shows live cloud status — instance/VM state,
  public IP or load-balancer address, TLS certificate issuance state (ACM /
  Google-managed cert / Application Gateway Key Vault cert), database
  reachability, and the app's health-check result. Never throws; failures
  in individual checks are reported inline rather than aborting the whole
  command.

### `cc logs`

```bash
./deploy/cc logs
./deploy/cc logs -f          # or --follow, stream continuously
```

Shows `docker compose logs` for the app stack. Currently local-target only
(the Local target is where a laptop deployment's logs matter most — cloud
targets are typically monitored through your own log aggregation once
live).

### `cc update`

```bash
./deploy/cc update
```

Rebuilds the app image from your **current working tree** and reships it to
whatever infrastructure this deployment already has — **without touching
that infrastructure at all**. No `terraform apply`, no instance/network/
database changes for cloud targets; for Local, just `docker compose up
--build` (only ever replaces the app container, never the Postgres volume
or network).

This is the deliberate scope boundary versus `cc up`: `cc up` can
create/resize infrastructure, `cc update` only ever ships new application
code onto infra that already exists. If you need an actual infra change
(bigger instance, different region, HA topology), that's `cc destroy` +
a fresh `cc up` — `cc update` intentionally cannot do that.

Per target, this uses:

| Target | Mechanism |
|---|---|
| Local | `docker compose up --build` |
| AWS | Build image → upload artifact to S3 → SSM RunCommand deploys it on the instance(s) (rolling, one at a time, for HA) |
| GCP | Build image → upload artifact to GCS → `gcloud compute ssh --tunnel-through-iap` runs the deploy script |
| Azure | Build image → upload artifact to Blob Storage → `az vm run-command invoke` runs the deploy script |

### `cc telnyx`

```bash
./deploy/cc telnyx
./deploy/cc telnyx --no-number          # skip phone number search/purchase
./deploy/cc telnyx --country GB         # country code for number search (default US)
```

Standalone re-run/repair of the Telnyx bootstrap step for an **existing**
deployment — works for every target (Local, AWS, GCP, Azure). Every
resource it touches (outbound voice profile, voice app, WebRTC SIP
connection, Default Call Flow voice app, phone number) is created via a
find-by-name upsert, so this is always safe to re-run: it repairs anything
missing (e.g. you deleted the voice app by hand in the Telnyx portal) and
picks up a phone number if one hasn't been assigned yet, without touching
or duplicating anything that already exists.

If Telnyx bootstrap produces new config values (a freshly created/repaired
resource id), `cc telnyx` automatically merges them into the deployment's
env store (`docker/production/.env` for Local, the cloud provider's
secret/Key Vault store for AWS/GCP/Azure) and **rebuilds + reships the app**
so the change actually takes effect — `NEXT_PUBLIC_*`/`TELNYX_*` values are
baked into the image at build time, so there's no lighter "just restart"
path.

### `cc destroy`

```bash
./deploy/cc destroy         # stop containers / tear down cloud infra (double-confirmed)
./deploy/cc destroy -v      # Local only: also delete data volumes (DESTRUCTIVE, double-confirmed)
```

- **Local:** stops the Docker Compose stack (`-v` also deletes the Postgres
  data volume, media, logs). Also stops any auto-started Cloudflare quick
  tunnel process.
- **AWS:** tears down all Terraform-managed infrastructure (EC2, RDS, VPC,
  ALB, S3, Secrets Manager) via `terraform destroy`, then offers to delete
  the ACM certificate too (only if this wizard run requested a *new*
  certificate for this deployment — never a shared/pre-existing one).
- **GCP:** tears down all Terraform-managed infrastructure (Compute Engine,
  Cloud SQL, VPC, GCS bucket, Secret Manager) via `terraform destroy`. The
  CLI proactively reconciles Terraform state before destroying (see
  [Troubleshooting](#troubleshooting)) so partial-state retries and known
  GCP backend race conditions (Cloud SQL database/user deletion, VPC
  Service Networking Connection teardown) don't block the run.
- **Azure:** tears down all Terraform-managed infrastructure (VM, Postgres
  Flexible Server, VNet, Storage Account, Key Vault) via `terraform
  destroy`, and also purges the soft-deleted Key Vault afterward so a
  same-named `cc up` later doesn't collide with it.

After infra teardown (or immediately, for Local), you're offered a
**separate** confirmation to also clean up this deployment's Telnyx
resources (voice app, outbound voice profile, WebRTC SIP connection,
Default Call Flow voice app) — kept separate from infra teardown because
they're independent failure domains. Releasing the phone number itself is a
**third**, even more explicit opt-in, since release is permanent (the
number returns to Telnyx's general pool).

`terraform destroy` is always safe to re-run against a partial state — if a
destroy run fails partway through, just run `cc destroy` again.

### `cc clean`

```bash
./deploy/cc clean
```

Resets a `deploy/` checkout back to a fresh-clone state — removes
`.cc-state.json`, `.cc-credentials.txt`, `.cc-telnyx-secrets.json`,
`docker/production/.env`, `.cc-tunnel.log`, `cc.answers.json`, and each AWS
Terraform root's `cc.auto.tfvars.json` / `terraform.tfstate(.backup)` /
`.terraform/` / `.terraform.lock.hcl`.

**Every file is backed up first.** Everything found is copied into
`deploy/.cc-backups/backup_<timestamp>/` (path preserved relative to the
repo root) and only removed after the copy is verified — so a mistaken `cc
clean` is always recoverable, and if you ran it instead of `cc destroy`
while real cloud infra was still up, the Terraform state backup is enough
to finish a `cc destroy` later.

If a `terraform.tfstate` file still tracks live resources, you get a loud
warning and the confirmation default flips from yes to no — deleting that
file without destroying first orphans the infrastructure it tracks.

**Use `cc destroy` to tear down real infrastructure. Use `cc clean` only to
reset local wizard artifacts** (e.g. after a state file got corrupted, or
you want to start a brand-new deployment in the same checkout).

---

## Deployment targets

Run `cc up` and the first prompt is **"Where do you want to deploy Contact
Center?"** — the menu offers four fully-implemented targets:

| Target | Menu label | Notes |
|---|---|---|
| **Local** | `Local machine (Docker Desktop / Docker Engine) — dev & evaluation` | Dev/eval on your own machine |
| **AWS** | `AWS (EC2 + EIP + Route53 optional)` | from ~$30/mo (t3a.medium) |
| **Azure** | `Azure (VM + Public IP)` | |
| **GCP** | `GCP (Compute Engine)` | |

### Local (Docker)

Runs the full stack (app + Postgres) as Docker containers on your own
machine via `docker compose`. No cloud account, no Terraform, no cost
beyond your own hardware. Best for development, evaluation, and demos.

The wizard prompts for:

| Field | Why |
|---|---|
| Deployment name | Used to name Telnyx resources (voice app, SIP connection, number) |
| Public domain | Optional — leave blank to auto-start a Cloudflare quick tunnel (see [Webhook tunnels](#webhook-tunnels-local-target-only)) |
| Owner admin email/password | Seeds the first owner account (auto-generated password if left blank) |
| Telnyx API key | Used for the Telnyx bootstrap step (voice app, number, SIP connection) |

Sizing is skipped entirely for Local — always single-node/small. Region is
skipped too — there's no cloud region for your own laptop.

If port 5432 (or another required port) is already taken — commonly by a
Postgres you already run locally — the wizard offers to either run the
bundled Postgres container on a different host port, or point Contact
Center at your existing Postgres instead (with a live connection probe and
protection against silently overwriting an existing `contact_center`
database).

`docker/production/.env` gets every value the app needs
(`NEXTAUTH_SECRET`, `POSTGRES_PASSWORD`, `SECRETS_ENCRYPTION_KEY`, Telnyx
resource ids, …) auto-generated and written for you.

### AWS

Provisions via Terraform: EC2 instance(s), VPC, an Elastic IP (single-node)
or Application Load Balancer + ACM certificate (HA/multi-node or opt-in on
single-node), RDS Postgres, S3 for artifact/media storage, and Secrets
Manager for the app's runtime secrets.

The wizard additionally asks for/handles:

- **Region** — a curated fast-path menu (`eu-central-1`, `eu-west-1`,
  `us-east-1`, `us-east-2`, `us-west-2`, or "Other" to type any AWS region
  code).
- **Admin SSH access** — auto-resolved, never asked: the wizard opens port
  22 only to AWS's own published EC2 Instance Connect IP range for the
  chosen region, so the EC2 console's browser "Connect" button works
  without exposing SSH to the whole internet.
- **HTTPS (ALB + ACM)** — for single-node, you're asked whether to front
  the deployment with an Application Load Balancer + ACM certificate (an
  existing certificate covering your domain is auto-discovered and offered
  first; otherwise a new one is requested and DNS-validated automatically
  if the domain's hosted zone lives in the same AWS account). HA/multi-node
  always requires it. Declining means plain HTTP directly on the instance —
  your own reverse proxy/CDN would need to handle TLS.
- **Route53 DNS** — if your domain's hosted zone is found in this AWS
  account, the wizard offers to manage the A/alias record automatically;
  otherwise it prints the exact record to create by hand.
- **Portainer agent (opt-in)** — install a Portainer *agent* only (no
  bundled Portainer server) so you can manage the node(s) from your own
  existing Portainer instance.

**Preflight for AWS additionally checks:** Terraform >= 1.7, AWS CLI
credentials (`aws sts get-caller-identity`), a full IAM permission
precheck against the exact actions Terraform will need (see
`deploy/terraform/aws-required-policy.json` for the reference policy), and
EIP quota headroom for the chosen topology/node count.

Sizing determines topology automatically: **Small/Medium → single-node**,
**Large → multi-node/HA** (ALB + ACM become mandatory, one deploy per node
rolled out sequentially).

### GCP

Provisions via Terraform: a Compute Engine instance, VPC, Cloud SQL
(Postgres), a GCS bucket for storage, and Secret Manager for runtime
secrets. Phase 1/2 scope — single-node only, no HA/multi-node root yet.

The wizard additionally asks for:

- **GCP project id** — must already exist (the wizard never creates
  projects); looped until non-empty, since Terraform has no safe default
  and creating billable resources in the wrong project is a far worse
  failure mode than one extra prompt.
- **Region** — a curated fast-path menu (`us-central1`, `us-east1`,
  `us-west1`, `europe-west1`, `europe-west3`, or "Other").
- **Zone** — within the chosen region, for the Compute Engine instance
  (defaults to `<region>-a`, editable).
- **HTTPS Load Balancer (opt-in)** — a global HTTPS Load Balancer +
  Google-managed SSL certificate for your domain. Declining (the Phase 1/2
  default) means plain HTTP directly on the instance's public IP.
- **Cloud DNS automation** — only runs if you opted into the Load
  Balancer: if a Cloud DNS managed zone matching your domain is found in
  the project, the wizard offers to create/overwrite the A record
  automatically.
- **Portainer agent (opt-in)** — same agent-only model as AWS.

**Preflight for GCP additionally checks:** Terraform >= 1.7, `gcloud` CLI
presence, active `gcloud auth login` session, Application Default
Credentials (`gcloud auth application-default login` — Terraform's
`google` provider needs these separately from the CLI's own login), and
that the given project id is describable/reachable by the active account.

Remote deploy uses `gcloud compute ssh --tunnel-through-iap` (no SSM-style
agent needed — GCP's IAP firewall rule, already opened by the network
module, is enough). Artifacts ship to GCS via `gcloud storage cp`.

### Azure

Provisions via Terraform: a VM, VNet, Azure Postgres Flexible Server, a
Storage Account + container for storage, and Key Vault for runtime
secrets. Phase 1/2/3 scope — single-node only, no HA/multi-node root yet.

The wizard additionally asks for:

- **Azure subscription id** — no account-wide default the way AWS CLI has
  a default profile; looped until non-empty (`az account show --query id
  -o tsv` if you need to look it up), same rationale as GCP's project id
  prompt.
- **Region** — a dedicated popular-region menu (`westeurope`,
  `northeurope`, `uksouth`, `swedencentral`, `eastus`, `eastus2`,
  `centralus`, `westus2`, or "Other"). Unlike AWS/GCP's small region
  namespaces, Azure has 60+ physical regions, so a free-typed "Other"
  answer is **validated** against a live `az account list-locations` call
  (with a built-in offline snapshot fallback if `az` isn't reachable yet) —
  a typo like `eastus-2` is caught immediately instead of surfacing later
  as an opaque Terraform/ARM error.
- **Application Gateway v2 (opt-in)** — an Application Gateway + TLS
  certificate for your domain. Declining (the default) means plain HTTP
  directly on the instance's public IP. If enabled, the certificate can
  come from three sources: an existing certificate already imported into
  this deployment's Key Vault, a freshly-issued Let's Encrypt certificate
  via ACME DNS-01 (only offered when Azure DNS is managing the zone — it
  needs to create the challenge TXT record), or a manually-imported PFX
  you provide yourself.
- **Azure DNS automation** — mirrors GCP's Cloud DNS automation, gated the
  same way (only runs if you opted into the Application Gateway).

**Preflight for Azure additionally checks:** Terraform >= 1.7, Azure CLI
presence, and an active session — either `az login` (interactive user) or
a Service Principal via `ARM_SUBSCRIPTION_ID` / `ARM_TENANT_ID` /
`ARM_CLIENT_ID` / `ARM_CLIENT_SECRET` environment variables (Terraform's
`azurerm` provider prefers the Service Principal env vars when present,
otherwise falls back to `az`'s own CLI session).

Remote deploy uses `az vm run-command invoke` (synchronous, single call —
no async send/poll like AWS SSM, no SSH tunnel like GCP). Artifacts ship
to Blob Storage via `az storage blob upload`. Secrets live in **one shared
Key Vault per deployment** rather than a flat Secrets Manager/Secret
Manager namespace.

---

## Wizard steps in detail

Every `cc up` run walks through these steps in order (skipped/auto-resolved
steps are noted). Progress is saved after each one, so a resumed run picks
up exactly where it left off.

1. **Consent** — shows what the wizard will do and confirms before
   anything is created.
2. **Target** — pick Local / AWS / Azure / GCP.
3. **Size** — expected scale (Small ≤10 users, Medium ≤100, Large ≤1000 —
   see [Sizing](#sizing)). Skipped for Local (always small/single-node).
4. **Region** — cloud targets only, skipped for Local. Provider-specific
   menu (see each target's section above) plus any provider-specific
   follow-ups (GCP project id + zone, Azure subscription id, AWS admin SSH
   CIDR auto-resolution).
5. **Portainer (AWS/GCP only)** — opt-in Portainer agent.
6. **DNS/TLS decision (cloud only)** — ALB+ACM (AWS), HTTPS Load Balancer
   (GCP), or Application Gateway (Azure); plus DNS zone automation if a
   managed zone matching your domain is found.
7. **Deployment params** — deployment name, public domain (mandatory for
   cloud targets; optional for Local, see
   [Webhook tunnels](#webhook-tunnels-local-target-only)), owner admin
   email/password, Telnyx API key.
8. **Port-conflict resolution (Local only)** — only reached if a required
   port is already bound; see [Local target](#local-docker) above.
9. **Preflight** — every check appropriate to the target (see each
   target's section above for the extra cloud-specific checks). Any `fail`
   blocks continuing; `warn` lets you proceed.
10. **Telnyx bootstrap** — creates/repairs (find-by-name upsert, always
    idempotent): outbound voice profile, WebRTC SIP voice app, SIP
    connection, Default Call Flow voice app, and searches/purchases an
    inbound phone number for the given country.
11. **Provision infra** — Local: `docker compose up --build`. Cloud:
    `terraform apply`, then build + ship + deploy the app image onto the
    new infrastructure. This is the only step that creates billable cloud
    resources or a real Telnyx phone number purchase.
12. **Summary** — prints the app URL, owner login, generated password (if
    auto-generated — also saved to `deploy/.cc-credentials.txt`, chmod
    600), inbound number, cloud resource identifiers, DNS instructions (if
    DNS isn't automated), and the day-2 command list.

---

## Sizing

Reached for every target except Local (which is always Small/single-node):

| Size | Users | Default nodes | Notes |
|---|---|---|---|
| **Small** | up to 10 | 1 | demo / POC / small team |
| **Medium** | up to 100 | 1 | production, single site |
| **Large** | up to 1000 | 3 (AWS only) | production, HA required |

Large/HA multi-node is **currently AWS-only**. Picking Large on GCP or
Azure still deploys single-node (with a warning) — those providers don't
have a multi-node Terraform root yet.

---

## Non-interactive mode (CI, demos, re-install)

```bash
cat > deploy/cc.answers.json << 'JSON'
{
  "target": "local",
  "deploymentName": "cc-ci",
  "domain": "",
  "ownerEmail": "ci@example.com",
  "ownerPassword": "auto",
  "telnyxApiKey": "KEY..."
}
JSON
./deploy/cc up --non-interactive --config deploy/cc.answers.json
```

Answers are matched by keyword against each prompt's text (not by call
order), so it stays robust across step reordering. Any prompt not covered
by the answers file falls back to the step's own default, or throws with a
clear error naming the missing key — an unattended run never silently
guesses on something that matters (notably: `applyTerraform` must be
explicitly `true` for an AWS terraform apply to proceed, and `buyNumber`
must be explicitly `true` for a phone number purchase — both default to
`false`/deny so a scripted run never creates billable resources without
opting in).

Secrets (`ownerPassword`, `telnyxApiKey`) come from the answers file. Keep
it out of git — `.gitignore` already excludes `deploy/cc.answers.json`.
Leave `ownerPassword` empty (or `"auto"`) to auto-generate one. See
`deploy/cc.answers.json.example` for the minimal template.

---

## Webhook tunnels (Local target only)

Voice flows on a laptop can't receive inbound Telnyx webhooks without a
public HTTPS URL. How this is handled depends on what you enter at the
"Public domain" prompt during `./deploy/cc up`:

- **You give a domain or your own tunnel URL** (e.g. `cc.example.com`, a
  full URL like `https://api.example.com`, or your own already-running
  `cloudflared`/ngrok/etc. tunnel URL) — the wizard uses it as-is for the
  app URL and the Telnyx webhook. Both `https://host` and a bare `host`
  are accepted; the wizard normalizes it, so pasting a full URL never
  produces a doubled `https://https://...`.
- **You leave it blank (press Enter)** — the wizard **automatically starts
  a [cloudflared quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)**
  pointed at `localhost:3000`. No manual `cloudflared tunnel --url ...`
  step needed. The wizard:
  - starts the tunnel **before** building/starting containers (the tunnel
    URL is baked into the Next.js client bundle at build time, so it must
    exist first),
  - waits for cloudflared to report its `https://*.trycloudflare.com` URL,
  - uses that URL for the app's `.env`, the health check, and the Telnyx
    webhook registration,
  - prints the URL (and the tunnel's PID) in the final summary,
  - leaves the tunnel process running after the wizard exits (detached),
  - on a `./deploy/cc up` resume, reuses the still-running tunnel from the
    prior run instead of starting a new one (quick tunnels get a
    brand-new random hostname every time, so a redundant tunnel would mean
    needlessly re-registering the webhook),
  - is cleaned up automatically by `./deploy/cc destroy`.

  Because `cloudflared` becomes required (not just a nice-to-have) once you
  choose this path, `./deploy/cc up`'s preflight check will hard-fail if
  it's missing:

  ```bash
  brew install cloudflared    # macOS
  # or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  ```

> **Heads up:** WebSocket streaming (port 3001) is separate from the HTTP
> port. A single quick tunnel only proxies **one** port — there's no way to
> forward both 3000 and 3001 through one quick tunnel. The default seeded
> call flow (answer → speak → hangup) never uses streaming, so the
> auto-tunnel covers it out of the box. If you build a flow that adds
> streaming/AI nodes, you'll need a real domain or a named (authenticated)
> Cloudflare tunnel with an ingress config instead.

Cloud targets handle TLS via their own load balancer / reverse proxy setup
(see each target's section above) — no tunnel needed at all.

---

## Persistent state (`.cc-state.json`)

`deploy/.cc-state.json` (gitignored) records every wizard answer and
per-step completion status — target, region, deployment name, cloud
resource identifiers, Telnyx resource ids, DNS/TLS decisions. It's what
lets:

- `cc up` resume an interrupted run without re-asking already-answered
  questions,
- `cc status` / `cc logs` / `cc update` / `cc telnyx` / `cc destroy` all
  operate on "the deployment I already have" without re-asking target,
  region, or deployment name.

**Secrets are deliberately never written here** — only non-sensitive
identifiers (deployment name, region, resource IDs, URLs). Passwords and
API keys are threaded through in-memory only, or stored in the target's
own secret store (`docker/production/.env` for Local, Secrets Manager /
Secret Manager / Key Vault for cloud targets).

---

## File layout

```
deploy/
├── cc                          # POSIX shim: installs CLI deps on first run, then exec node
├── README.md                   # this file
├── .cc-state.json              # wizard state (gitignored, persists target/region/IDs)
├── .cc-credentials.txt         # auto-generated owner password, if any (gitignored, chmod 600)
├── .cc-backups/                # timestamped backups written by `cc clean` (gitignored)
├── cc.answers.json.example     # sample answers file for --non-interactive mode
├── cc.answers.json             # your own answers file, if you made one (gitignored)
├── cli/
│   ├── cc.mjs                  # command router (up/doctor/status/logs/update/telnyx/destroy/clean)
│   ├── package.json            # isolated dependency tree (@inquirer/prompts, chalk, acme-client, node-forge, pg)
│   ├── lib/                    # wizard steps, per-provider cloud orchestration, ui/state/envgen/preflight
│   │   ├── wizard.mjs                    # step definitions + per-target wizard tails + summaries
│   │   ├── state.mjs                     # .cc-state.json shape, load/save, resume detection
│   │   ├── preflight.mjs                 # target-agnostic preflight check registry
│   │   ├── aws-cloud.mjs / gcp-cloud.mjs / azure-cloud.mjs   # per-provider Terraform + deploy orchestration
│   │   ├── azure-regions.mjs             # Azure region menu + live/offline validation
│   │   ├── terraform.mjs                 # thin Terraform CLI wrapper (init/plan/apply/destroy/state)
│   │   ├── cloud-deploy.mjs              # shared image build/package/artifact-upload logic
│   │   ├── telnyx-bootstrap-orchestrator.mjs   # idempotent Telnyx resource upserts
│   │   └── clean.mjs                     # `cc clean`'s backup-then-remove logic
│   └── test/                   # node --test suites (500+ tests across every module above)
└── terraform/
    ├── aws/{single-node,multi-node}/     # AWS Terraform roots
    ├── gcp/single-node/                  # GCP Terraform root
    ├── azure/single-node/                # Azure Terraform root
    ├── modules/                          # cc-network-*, cc-compute-*, cc-database-*, cc-storage-*, cc-secrets-* per provider
    └── aws-required-policy.json          # reference IAM policy for the AWS preflight check
```

---

## Troubleshooting

- **`./deploy/cc doctor` first.** It's read-only and reports exactly which
  check is failing, with a hint for how to fix it.
- **AWS `terraform apply` failed partway through (e.g. EIP quota
  exceeded).** Just run `./deploy/cc destroy` — it operates directly on
  whatever Terraform state exists, partial or complete, and is always safe
  to re-run.
- **GCP `cc destroy` fails on Cloud SQL database/user or the Service
  Networking Connection ("still in use" / "N objects depend on it" /
  "Producer services ... are still using this connection").** This was a
  real, now-fixed class of bug: GCP's Terraform provider models the
  Cloud SQL database and user as separate resources with their own
  explicit-delete API call, and the VPC Service Networking Connection has
  a documented backend race condition on teardown. Both are fixed at the
  source (`deletion_policy = "ABANDON"` on the affected resources) *and*
  the CLI proactively reconciles Terraform state before every GCP destroy
  so even a deployment created before the fix landed tears down cleanly.
  If you still hit a destroy failure, just re-run `cc destroy` — GCP
  `terraform destroy` is safe against a partial state.
- **Lost or corrupted `.cc-state.json` but infrastructure might still be
  live.** Don't manually delete Terraform state files. Run `./deploy/cc
  clean` — it backs up everything (including any `terraform.tfstate` that
  still tracks live resources) before removing it, and warns loudly if a
  live state file is about to be touched.
- **Azure deploy succeeds, calls ring the agent, but the Interactions
  card / Interaction Details never update ("No interactions" /
  "Waiting for a call...").** This was a real, now-fixed bug: Azure
  Application Gateway v2 buffers the *entire* backend HTTP response
  before forwarding anything to the client, which is fatal for the SSE
  endpoints (`/api/user/status-stream`,
  `/api/contact-center/agent/stream`,
  `/api/contact-center/monitor/stream`) — a never-ending stream never
  "completes", so the browser never receives a byte through the
  gateway (WebRTC calls still ring fine because that traffic goes
  directly through the Telnyx SDK, bypassing the gateway entirely).
  Fixed at the source: `azurerm_application_gateway.app` now sets
  `global { response_buffering_enabled = false }`, so every new Azure
  deploy gets working SSE out of the box. If you're diagnosing this on
  an *older* deployment created before the fix landed, you can apply
  it live without a redeploy:
  `az network application-gateway update --name <gw-name> --resource-group <rg-name> --set globalConfiguration.enableResponseBuffering=false`
  (safe, instantly reversible by setting it back to `true`). See
  https://learn.microsoft.com/en-us/azure/application-gateway/use-server-sent-events.
- **Need to see what changed since a deployment was created?** `cc status`
  is always safe to run and never mutates anything.
