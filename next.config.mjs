import { createMDX } from "fumadocs-mdx/next";
import { createBuildInfo } from "./scripts/lib/build-info.mjs";
import { documentPreviewTracingIncludes } from "./scripts/lib/document-preview-tracing.mjs";

// Pass the snapshot to build workers so they share one timestamp and identity.
const applicationBuild = createBuildInfo();
process.env.CC_BUILD_INFO = JSON.stringify(applicationBuild);
const previewTracingIncludes = documentPreviewTracingIncludes();

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
  env: {
    NEXT_PUBLIC_CC_BUILD_INFO: JSON.stringify(applicationBuild),
    // The Maps Embed API key is read by the browser (it travels in the iframe
    // URL), so the server-side name is published under the NEXT_PUBLIC_ one.
    // Restrict this key to HTTP referrers and to the Maps Embed API.
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",
  },
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingIncludes: {
    "/api/contact-center/email/*/attachments/*/*": previewTracingIncludes,
    "/api/contact-center/interactions/*/conversation/email-drafts/*/attachments/*": previewTracingIncludes,
    "/api/contact-center/chat/*/attachments/*": previewTracingIncludes,
    "/api/contact-center/interactions/*/conversation/attachments/*": previewTracingIncludes,
    "/api/contact-center/interactions/*/conversation/email-attachments/*/*": previewTracingIncludes,
    "/api/widget-sessions/*": previewTracingIncludes,
  },
  // Configure body size limit for Server Actions (for profile picture uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
      allowedOrigins: allowedDevOrigins,
    },
    // Route handlers read multipart uploads themselves (chat attachments up
    // to 100 MB, waiting-playlist videos up to 64 MB). Next buffers request
    // bodies for the proxy up to this size and truncates the rest, which
    // left larger uploads with an unparsable form. (Next 16 name; the
    // pre-16 `middlewareClientMaxBodySize` is a deprecated alias.)
    proxyClientMaxBodySize: "110mb",
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
  async headers() {
    return [{ source: "/cobrowse/replay", headers: [{ key: "Content-Security-Policy",
      value: "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'" },
    { key: "Referrer-Policy", value: "no-referrer" }] }];
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

export default configuredNext;
