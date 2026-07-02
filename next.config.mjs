/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configure body size limit for Server Actions (for profile picture uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Allowed dev origins - required when using a reverse proxy (e.g. api.tokaj.synology.me)
  // Prevents "Blocked cross-origin request" which breaks HMR and causes ~40s page refreshes
  // Set ALLOWED_DEV_ORIGINS env var to override (comma-separated).
  allowedDevOrigins: [
    "api.tokaj.synology.me",
    "http://api.tokaj.synology.me",
    "https://api.tokaj.synology.me",
    ...(process.env.ALLOWED_DEV_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
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

export default nextConfig;
