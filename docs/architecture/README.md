# Architecture Documentation

This folder contains a production-readiness assessment of the Telnyx Contact Center application and a proposed path to evolve it into a distributed, customer-distributable system.

## Documents

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | [Current architecture](./01-current-architecture.md) | Inventory of today's runtime topology — what runs where, what state lives where, and which subsystems are stateful. |
| 02 | [Production-readiness gaps](./02-production-gaps.md) | The six categorical blockers preventing horizontal scaling, with file/line references. |
| 03 | [Target distributed architecture](./03-target-architecture.md) | Proposed AWS-managed-service topology, key design decisions, and component responsibilities. |
| 04 | [CDK distribution plan](./04-cdk-distribution.md) | Packaging the target architecture as a CDK construct that customers can `cdk deploy` to get their own contact center. |

## Reading order

If you're new to this material, read in order (01 → 04). Each doc assumes the previous as context.

If you're looking for a specific decision:

- **"What can't we just put behind a load balancer?"** → [02](./02-production-gaps.md), table at top.
- **"What does the target topology look like?"** → [03](./03-target-architecture.md), diagram in §1.
- **"How would a customer install this?"** → [04](./04-cdk-distribution.md), §2.
- **"What order should we do the work in?"** → [03](./03-target-architecture.md), §5 "Recommended sequencing."

## Scope and status

These are assessment / proposal documents, not implementation specs. They describe the current system accurately (with file/line references against the master branch) and propose a target architecture, but no migration work has started.

The proposed direction is:

1. Keep the existing Next.js codebase — it is well-structured enough to evolve.
2. Externalize state to Redis/ElastiCache.
3. Decouple webhook intake from flow execution via SQS.
4. Move durable artifacts (recordings, uploads) to S3.
5. Package the resulting stack as a CDK construct, distributed one-per-customer (single-tenant deployments).
