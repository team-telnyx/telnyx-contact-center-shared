import defaultMdxComponents from "fumadocs-ui/mdx";
import Link from "next/link";
import {
  IconArrowRight,
  IconBolt,
  IconBrandDocker,
  IconCloud,
  IconInfoCircle,
  IconLayoutDashboard,
  IconRocket,
  IconShieldCheck,
  IconTerminal2,
} from "@tabler/icons-react";
import { HelpTopicContent } from "@/components/help/HelpTopicContent";
import { DocsTerminal } from "@/components/help/DocsTerminal";
import { cn } from "@/lib/utils";

const cardToneClasses = {
  blue: "help-card-blue",
  green: "help-card-green",
  purple: "help-card-purple",
  amber: "help-card-amber",
};

function DocsCardGrid({ children }) {
  return <div className="help-card-grid">{children}</div>;
}

function DocsSectionCard({
  title,
  description,
  href,
  cta = "Open section",
  tone = "green",
  icon = "dashboard",
  command,
}) {
  const Icon = {
    admin: IconShieldCheck,
    agent: IconBolt,
    supervisor: IconLayoutDashboard,
    setup: IconRocket,
    cloud: IconCloud,
    docker: IconBrandDocker,
    dashboard: IconLayoutDashboard,
  }[icon] || IconLayoutDashboard;

  const content = (
    <>
      <span className="help-card-heading">
        <span className="help-card-icon">
          <Icon className="size-5" />
        </span>
        <span className="help-card-title">{title}</span>
      </span>
      <Icon aria-hidden="true" className="help-card-watermark" />
      <span className="help-card-copy">
        <span>{description}</span>
      </span>
      {command ? (
        <span className="help-card-terminal" aria-label={`Command: ${command}`}>
          <IconTerminal2 className="size-4" />
          <code>{command}</code>
        </span>
      ) : null}
      <span className="help-card-cta">
        {cta}
        <IconArrowRight className="size-4" />
      </span>
    </>
  );

  return href ? (
    <Link
      href={href}
      className={cn("help-section-card", cardToneClasses[tone])}
    >
      {content}
    </Link>
  ) : (
    <div className={cn("help-section-card", cardToneClasses[tone])}>
      {content}
    </div>
  );
}

function DocsCallout({ children, title = "Note", tone = "info" }) {
  return (
    <aside className={cn("help-callout", `help-callout-${tone}`)}>
      <IconInfoCircle className="size-5" />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </aside>
  );
}

function DocsFeatureGrid({ children }) {
  return <div className="help-feature-grid">{children}</div>;
}

function DocsFeature({ title, children, tone = "green" }) {
  return (
    <div className={cn("help-feature", cardToneClasses[tone])}>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function DocsDeployMatrix() {
  const targets = [
    ["Local Docker", "Single-machine Docker Compose stack with PostgreSQL and app containers.", "Best for demos and private installs."],
    ["AWS", "Terraform-managed EC2, RDS, ALB, S3, Secrets Manager, and optional HA topology.", "Uses SSM for updates."],
    ["GCP", "Terraform-managed Compute Engine, Cloud SQL, VPC, GCS, Secret Manager, and managed TLS.", "Supports IAP tunnel deploys."],
    ["Azure", "Terraform-managed VM, Postgres Flexible Server, VNet, Storage Account, Key Vault, and TLS flow.", "Uses VM run-command updates."],
  ];

  return (
    <div className="help-deploy-matrix">
      {targets.map(([name, body, note]) => (
        <div key={name}>
          <strong>{name}</strong>
          <p>{body}</p>
          <span>{note}</span>
        </div>
      ))}
    </div>
  );
}

function ChangelogEntry({ title, date, pr, children }) {
  return (
    <article className="help-changelog-entry">
      <div>
        <span>{date}</span>
        {pr ? (
          <Link href={pr} target="_blank" rel="noopener noreferrer">
            PR
          </Link>
        ) : null}
      </div>
      <h2>{title}</h2>
      <div>{children}</div>
    </article>
  );
}

export function getMDXComponents(components = {}) {
  return {
    ...defaultMdxComponents,
    ChangelogEntry,
    DocsCallout,
    DocsCardGrid,
    DocsDeployMatrix,
    DocsFeature,
    DocsFeatureGrid,
    DocsSectionCard,
    DocsTerminal,
    HelpTopicContent,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;
