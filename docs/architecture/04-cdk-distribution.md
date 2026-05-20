# 04 — CDK Distribution Plan

> **Status:** Proposal. Assumes the target architecture in [03](./03-target-architecture.md) is in place.

## 1. Why CDK fits unusually well here

The target architecture is built entirely from managed AWS services — every component has a first-class CDK construct. Combined with the [single-tenant-per-stack decision](./03-target-architecture.md#31-tenancy-single-tenant-per-stack), this means a customer-distributable product reduces to:

1. A CDK construct library (`@telnyx/contact-center-cdk`) published on npm.
2. Container images published to public ECR.
3. A short "getting started" doc telling the customer to write ~10 lines and run `cdk deploy`.

No long-running provisioning service, no per-customer infrastructure operations team, no shared multi-tenant database to keep clean.

## 2. Customer experience

The whole bootstrap a customer writes:

```typescript
// bin/app.ts
import * as cdk from 'aws-cdk-lib';
import { TelnyxContactCenterStack } from '@telnyx/contact-center-cdk';

const app = new cdk.App();

new TelnyxContactCenterStack(app, 'TCC', {
  env: { account: '123456789012', region: 'us-east-1' },
  domain: 'cc.acme.com',                    // Route53 + ACM
  telnyxApiKeySecretArn: 'arn:aws:secretsmanager:...',
  capacity: { min: 2, max: 10 },            // Fargate task scaling
  rdsInstance: 'db.r6g.large',
  redisNode:   'cache.r7g.large',
  recordingsRetentionDays: 365,
});
```

Then:

```bash
npm install
cdk bootstrap   # one-time per account/region
cdk deploy
```

CDK outputs the URL, an admin invite link, and the Telnyx webhook URL the customer needs to register in their Telnyx portal.

## 3. What the construct creates

A single root stack composed of nested constructs:

| Layer | Resources | CDK module |
|-------|-----------|------------|
| **Networking** | VPC (3 AZs), public + private subnets, NAT, VPC endpoints for S3 / Secrets Manager / ECR / Logs | `aws-cdk-lib/aws-ec2` |
| **Compute** | ECS Fargate cluster + three services: `web`, `webhook-receiver`, `flow-worker`, each with its own autoscaling policy | `aws-cdk-lib/aws-ecs`, `ecs-patterns` |
| **Edge** | Application Load Balancer, ACM certificate, Route53 A record, WAF rules (rate limiting, OWASP managed rules) | `aws-cdk-lib/aws-elasticloadbalancingv2`, `aws-certificatemanager`, `aws-route53`, `aws-wafv2` |
| **Data — durable** | RDS Postgres Multi-AZ, automated backups, parameter group tuned for OLTP | `aws-cdk-lib/aws-rds` |
| **Data — real-time** | ElastiCache Redis cluster mode, automatic failover, encryption at rest + in transit | `aws-cdk-lib/aws-elasticache` |
| **Queue** | SQS FIFO queue (per-call message group) + DLQ + redrive policy | `aws-cdk-lib/aws-sqs` |
| **Object storage** | S3 buckets for recordings + form media, lifecycle rules, SSE-KMS, public-access-block | `aws-cdk-lib/aws-s3` |
| **Secrets** | App-generated secrets (NEXTAUTH_SECRET, encryption key) in Secrets Manager. Telnyx key is **referenced**, not owned — customer brings their own ARN | `aws-cdk-lib/aws-secretsmanager` |
| **Schedules** | EventBridge Scheduler rules invoking Lambdas for cron jobs | `aws-cdk-lib/aws-scheduler`, `aws-lambda` |
| **Migrations** | One-shot ECS task that runs `node-pg-migrate up` on each `cdk deploy`, triggered via custom resource | `aws-cdk-lib/aws-ecs`, `custom-resources` |
| **Observability** | CloudWatch Log Groups per service, dashboards, alarms (queue depth, DLQ size, p99 latency, RDS CPU, Redis evictions), X-Ray sampling | `aws-cdk-lib/aws-cloudwatch`, `aws-xray` |
| **IAM** | Per-service task roles, least-privilege policies bound to specific Secret ARNs / S3 prefixes / SQS queue ARNs | `aws-cdk-lib/aws-iam` |

## 4. Distribution mechanics

### 4.1 npm package

`@telnyx/contact-center-cdk` ships:

- The `TelnyxContactCenterStack` class.
- Inner constructs that customers can extend (e.g., `WebService`, `WorkerFleet`) if they need to add sidecars or custom IAM policies.
- A typed `props` interface that documents every customer-facing knob.

Versioning follows semver. Breaking infrastructure changes get a major version bump and a migration note.

### 4.2 Container images

Three images, published to **public ECR Gallery**:

- `public.ecr.aws/telnyx/contact-center-web`
- `public.ecr.aws/telnyx/contact-center-webhook-receiver`
- `public.ecr.aws/telnyx/contact-center-flow-worker`

Each tagged with the same version as the npm package, so `@telnyx/contact-center-cdk@1.4.2` pins to `:1.4.2` images. Customers can't accidentally mix versions.

### 4.3 Upgrade flow

```bash
npm update @telnyx/contact-center-cdk
cdk diff      # shows infra changes
cdk deploy    # applies infra; ECS rolling-deploys new images; migrations run via custom resource
```

Schema migrations are auto-applied. Customers see them in `cdk diff` because the custom resource changes versions.

### 4.4 Optional: Service Catalog product

For enterprise customers that require deployments to land in a Control Tower / Landing Zone, we can also publish as an **AWS Service Catalog product**. Same construct under the hood, packaged as a product portfolio they can grant to specific accounts/OUs.

## 5. Customer-facing knobs (props interface sketch)

```typescript
interface TelnyxContactCenterStackProps extends cdk.StackProps {
  /** Public hostname for the contact center UI. Route53 hosted zone must exist. */
  domain: string;

  /** ARN of a Secrets Manager secret containing the Telnyx API key.
   *  Customer creates and rotates this themselves. */
  telnyxApiKeySecretArn: string;

  /** Fargate task scaling for the web tier. */
  capacity?: {
    min?: number;      // default 2
    max?: number;      // default 10
    cpu?: number;      // default 1024 (1 vCPU)
    memoryMiB?: number; // default 2048
  };

  /** RDS instance class. Default db.r6g.large. */
  rdsInstance?: string;

  /** ElastiCache node type. Default cache.r7g.large. */
  redisNode?: string;

  /** S3 lifecycle for recordings. Default 365 days. */
  recordingsRetentionDays?: number;

  /** Allow signups only from these email domains. */
  allowedEmailDomains?: string[];

  /** Optional: Google OAuth credentials (referenced from Secrets Manager). */
  googleOAuth?: {
    clientIdSecretArn: string;
    clientSecretArn: string;
  };

  /** Optional: alarms route to this SNS topic. */
  alarmTopicArn?: string;
}
```

Anything not in this interface is fixed by the construct — that's how we ship opinions instead of options.

## 6. What the customer is responsible for

| Concern | Customer responsibility | Construct responsibility |
|---------|-------------------------|--------------------------|
| AWS account, billing, region | ✓ | |
| Telnyx account, API key, Voice App config, webhook URL registration | ✓ | (Construct outputs the webhook URL to register) |
| Route53 hosted zone for the domain | ✓ | Creates the record inside it |
| ACM cert | | ✓ (DNS-validated, automatically issued) |
| Secrets Manager entry for Telnyx key | ✓ (creates and rotates) | Reads it via IAM |
| RDS / Redis backups | | ✓ (default 7-day retention, configurable) |
| Schema migrations | | ✓ (auto-applied on `cdk deploy`) |
| Container image updates | | ✓ (via npm package version bump) |
| Monitoring (alarms, dashboards) | | ✓ |
| Disaster recovery testing | ✓ | (Construct provides the primitives) |

## 7. What this distribution model does *not* cover

To set expectations:

- **Not a managed service.** Customers run the stack in their own account; we don't have access to their data or runtime.
- **Not multi-tenant.** Each customer is one stack. No cross-tenant features (shared agent pools, federated reporting) are possible from this distribution shape.
- **Not air-gapped.** The app makes outbound calls to Telnyx, Azure, Google, Mailgun. Customers behind strict egress controls need to whitelist these endpoints.
- **Not turn-key on day 1.** Customers still need to seed admin users, configure queues, design voice flows, and set up agents. The stack provisions the infrastructure; the operational setup is documented separately.

## 8. Build-out estimate

Rough sequencing for the CDK work, assuming the target architecture in [03](./03-target-architecture.md) is already in place:

| Phase | Scope | Effort |
|-------|-------|--------|
| **A. Skeleton stack** | VPC, ALB, single ECS service running web tier; manual RDS / Redis | 1–2 weeks |
| **B. All services + queue** | Webhook receiver, flow worker, SQS, migrations custom resource, scheduled Lambdas | 2–3 weeks |
| **C. Observability + alarms** | Dashboards, alarms, SNS topic wiring, X-Ray sampling | 1 week |
| **D. Customer-facing polish** | Props interface, docs, examples, getting-started guide | 1–2 weeks |
| **E. ECR publish + npm publish + CI release pipeline** | Multi-arch image builds, semver release automation, version pinning | 1 week |

Total: **~7–10 weeks** of focused engineering work for a first GA release, on top of the architecture migration itself.
