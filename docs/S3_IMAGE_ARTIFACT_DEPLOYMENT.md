# S3 Docker image artifacts deployment

This repo can build the production Docker image once in GitHub Actions, store it
as an immutable tarball in S3, and deploy the same image to HA or legacy EC2
hosts with different runtime `.env` files.

## Model

```text
Git ref/SHA
  -> GitHub Actions builds docker/production/Dockerfile
  -> docker save | zstd
  -> S3 prefix with image.tar.zst, checksum, manifest.json
  -> EC2 downloads, verifies checksum, docker load, recreates container
```

The image is immutable and environment-neutral where possible. Runtime secrets
and environment-specific values stay on the EC2 host in `/opt/<app>/app.env` or
are refreshed from Secrets Manager before deployment.

> Important: `NEXT_PUBLIC_*` values are compiled into the Next.js client bundle
> during `yarn build`. If the exact same image will run on HA and legacy PROD,
> keep those values empty/shared or verify that the UI does not require
> environment-specific public values. Server-only values still belong in the
> runtime `.env` and can differ per host.

## One-time setup

### 1. S3 bucket

Create or choose a private artifact bucket, for example:

```bash
aws s3api create-bucket \
  --bucket fde-app-artifacts-260957529682 \
  --region us-east-2 \
  --create-bucket-configuration LocationConstraint=us-east-2

aws s3api put-public-access-block \
  --bucket fde-app-artifacts-260957529682 \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket fde-app-artifacts-260957529682 \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket fde-app-artifacts-260957529682 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

### 2. GitHub Actions AWS role

Configure repository/environment variable:

```text
AWS_ROLE_TO_ASSUME=arn:aws:iam::<account-id>:role/cc-build-artifact-writer
```

The role should trust GitHub OIDC for this repository and allow writes only to
the artifact prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::fde-app-artifacts-260957529682/contact-center/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::fde-app-artifacts-260957529682",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["contact-center/*"]
        }
      }
    }
  ]
}
```

### 3. EC2 instance role

Every deploy target needs read-only access to the same prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::fde-app-artifacts-260957529682/contact-center/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::fde-app-artifacts-260957529682",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["contact-center/*"]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:UpdateInstanceInformation",
        "ssmmessages:*",
        "ec2messages:*"
      ],
      "Resource": "*"
    }
  ]
}
```

In practice use `AmazonSSMManagedInstanceCore` plus the S3 read policy.

### 4. Operator permissions

The operator that runs `scripts/deploy-artifact-ssm.sh` needs:

- `ssm:SendCommand`
- `ssm:GetCommandInvocation`
- `ec2:DescribeInstances`
- for HA only: `elasticloadbalancing:RegisterTargets`,
  `elasticloadbalancing:DeregisterTargets`, `elasticloadbalancing:DescribeTargetHealth`

## Recommended operator path: FDE Infra CLI

For routine operations, use [FDE Infra CLI](https://github.com/team-telnyx/fde-infra-cli) instead of running the low-level scripts directly. The CLI discovers Contact Center environments from EC2 `Fde*` tags, lists known S3 artifacts, triggers this GitHub Actions workflow when an operator explicitly asks for a new build, deploys selected artifacts via AWS SSM, checks health, and supports rollback by selecting an older artifact prefix.

Low-level commands below document what the CLI automates and are useful for break-glass/debugging, but they should not replace the normal artifact-based workflow.

## Build an artifact

From GitHub:

```bash
gh workflow run build-s3-image-artifact.yml \
  -f ref=master \
  -f artifact_bucket=fde-app-artifacts-260957529682 \
  -f artifact_prefix=contact-center \
  -f aws_region=us-east-2
```

The workflow summary prints the immutable S3 prefix, for example:

```text
s3://fde-app-artifacts-260957529682/contact-center/9f3a1c7d2e44
```

Each prefix contains:

```text
image.tar.zst
image.tar.zst.sha256
manifest.json
```

## Configure deploy targets

Copy the example and replace placeholders with live instance IDs, tags, and HA
target group ARNs:

```bash
cp deploy/targets.example.json deploy/targets.json
```

`deploy/targets.json` is intentionally not required by the repo; keep real
account IDs and instance IDs out of public examples when needed.

## Deploy to legacy CC PROD

Legacy PROD uses the simple single-container restart path. No blue/green is
configured because migration target is HA.

```bash
./scripts/deploy-artifact-ssm.sh \
  --target legacy-cc-prod \
  --artifact s3://fde-app-artifacts-260957529682/contact-center/9f3a1c7d2e44 \
  --config deploy/targets.json
```

On the EC2 host, the SSM command:

1. uploads `scripts/deploy-from-s3.sh` to `/tmp/cc-artifact-deploy/`,
2. downloads the S3 artifact,
3. verifies `sha256sum`,
4. runs `docker load`,
5. recreates the configured container with the host env file,
6. checks `http://127.0.0.1:3000/api/health`,
7. rolls back to the previous recorded image if health fails.

## Deploy to HA

HA deploys one node at a time. If target group ARNs are configured, the script
removes the node from the app and WebSocket target groups before deployment,
waits for drain, deploys through SSM, registers the node back, and waits for
healthy target status before moving to the next node.

```bash
./scripts/deploy-artifact-ssm.sh \
  --target cc-ha \
  --artifact s3://fde-app-artifacts-260957529682/contact-center/9f3a1c7d2e44 \
  --config deploy/targets.json
```

## Direct host deploy

If you are already on an EC2 host and want to bypass SSM:

```bash
sudo APP_NAME=telnyx-contact-center \
  CONTAINER_NAME=telnyx-contact-center-app \
  ENV_FILE=/opt/telnyx-contact-center/app.env \
  ./scripts/deploy-from-s3.sh \
  s3://fde-app-artifacts-260957529682/contact-center/9f3a1c7d2e44
```

## Rollback

Fast rollback is just deploying a previous artifact prefix:

```bash
./scripts/deploy-artifact-ssm.sh \
  --target legacy-cc-prod \
  --artifact s3://fde-app-artifacts-260957529682/contact-center/<previous-short-sha> \
  --config deploy/targets.json
```

The host also records the last successfully deployed Docker image in
`/opt/<app>/current-image`; if a new deployment fails health checks, the host
script attempts an automatic rollback to that image.
