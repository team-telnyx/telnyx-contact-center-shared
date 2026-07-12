import { createMDX } from "fumadocs-mdx/next";

function devOriginHostname(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    return new URL(candidate.includes("://") ? candidate : `http://${candidate}`).hostname;
  } catch {
    return candidate.replace(/^https?:\/\//, "").split(/[/:]/)[0];
  }
}

const allowedDevOrigins = [...new Set([
  "localhost",
  "127.0.0.1",
  devOriginHostname(process.env.NEXT_PUBLIC_BASE_URL),
  devOriginHostname(process.env.NEXTAUTH_URL),
  devOriginHostname(process.env.APP_BASE_URL),
  ...(process.env.ALLOWED_DEV_ORIGINS || "").split(",").map(devOriginHostname),
].filter(Boolean))];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configure body size limit for Server Actions (for profile picture uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
      allowedOrigins: allowedDevOrigins,
    },
  },
  // Allowed dev origins - required when using a reverse proxy (e.g. your-dev-server.example.com)
  // Prevents "Blocked cross-origin request" which breaks HMR and causes ~40s page refreshes
  // Set ALLOWED_DEV_ORIGINS env var to override (comma-separated).
  allowedDevOrigins,
  // Serve runtime-uploaded media from the mounted public/media directory.
  // A beforeFiles rewrite avoids relying on Next's static-file snapshot/cache for files created after build.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/media/:path*",
          destination: "/api/media/:path*",
        },
      ],
    };
  },
  // Server-side externals for Turbopack (Next.js 16+)
  // ws, bufferutil, utf-8-validate are needed for Telnyx WebSocket TTS
  serverExternalPackages: ["pg", "pgpass", "pg-connection-string", "ws", "alawmulaw", "@google/genai", "bufferutil", "utf-8-validate"],
  // Turbopack configuration (used when not passing --webpack)
  turbopack: {
    root: process.cwd(),
    resolveAlias: {},
  },
  // Webpack configuration (only used when --webpack flag is explicitly set)
  webpack: (config, { isServer, dev }) => {
    if (isServer) {
      // Handle externals properly for server-side code
      // Includes ws and native deps for Telnyx WebSocket TTS
      const serverExternals = ["pg", "pgpass", "pg-connection-string", "ws", "bufferutil", "utf-8-validate"];
      if (Array.isArray(config.externals)) {
        config.externals.push(...serverExternals);
      } else if (typeof config.externals === "function") {
        const originalExternals = config.externals;
        config.externals = async (context, request, callback) => {
          if (serverExternals.includes(request)) {
            return callback(null, `commonjs ${request}`);
          }
          return originalExternals(context, request, callback);
        };
      }
    }
    // In dev mode, configure file watching for reliable HMR
    if (dev) {
      config.watchOptions = {
        ignored: [
          "**/node_modules/**",
          "**/.next/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          "**/coverage/**",
          "**/*.log",
          "**/.DS_Store",
          "**/yarn-error.log",
          "**/npm-debug.log",
          "**/.yarn/**",
          "**/plan/**",
          "**/docs/**",
          "**/public/**",
          "**/.env*",
          "**/yarn.lock",
          "**/package-lock.json",
          // Ignore test directories (not app routes like workflows/[id]/test/)
          "**/__tests__/**",
          "**/tests/**",
          "**/*.test.*",
          "**/*.spec.*",
          "**/scripts/**",
          "**/docker/**",
          "**/*.md",
        ],
        aggregateTimeout: 300,
        poll: false,
        followSymlinks: false,
      };
    }
    return config;
  },
};

const withMDX = createMDX({
  configPath: "source.config.ts",
});

const configuredNext = withMDX(nextConfig);

// Fumadocs' metadata loader already falls back to the normal JSON/YAML loader
// when a file has no `?collection=` query. Next 16.1 removed `query` from the
// public Turbopack rule-condition schema, so let the loader perform that check
// instead of emitting an invalid Next config.
for (const pattern of ["*.json", "*.yaml"]) {
  const rule = configuredNext.turbopack?.rules?.[pattern];
  if (rule && !Array.isArray(rule) && rule.condition?.query) {
    const { condition: _condition, ...ruleWithoutLegacyCondition } = rule;
    configuredNext.turbopack.rules[pattern] = ruleWithoutLegacyCondition;
  }
}

export default configuredNext;
