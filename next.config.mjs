/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configure body size limit for Server Actions (for profile picture uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  allowedDevOrigins: ["tunnel.demotelnyx.com"],
  // Configure static file serving for media files
  async rewrites() {
    return [
      {
        source: "/media/:path*",
        destination: "/media/:path*",
      },
    ];
  },
  // Server-side externals for Turbopack (Next.js 16+)
  serverExternalPackages: ["pg", "pgpass", "pg-connection-string"],
  // Empty turbopack config to silence warning (serverExternalPackages handles externals)
  turbopack: {},
  // Reduce automatic reloads in dev mode
  // This helps prevent modals/sheets from closing during testing
  onDemandEntries: {
    // Keep pages in memory longer to reduce reloads
    maxInactiveAge: 60 * 1000, // 60 seconds
    pagesBufferLength: 5,
  },
  // Webpack configuration (only used when --webpack flag is explicitly set)
  webpack: (config, { isServer, dev }) => {
    if (isServer) {
      // Handle externals properly for server-side code
      if (Array.isArray(config.externals)) {
        config.externals.push("pg", "pgpass", "pg-connection-string");
      } else if (typeof config.externals === "function") {
        const originalExternals = config.externals;
        config.externals = async (context, request, callback) => {
          if (["pg", "pgpass", "pg-connection-string"].includes(request)) {
            return callback(null, `commonjs ${request}`);
          }
          return originalExternals(context, request, callback);
        };
      }
    }
    // In dev mode, configure file watching to be less aggressive
    if (dev && !isServer) {
      config.watchOptions = {
        ...config.watchOptions,
        // Ignore common files that shouldn't trigger reloads
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.next/**",
          "**/dist/**",
          "**/build/**",
          "**/*.log",
          "**/.env*",
          "**/coverage/**",
          "**/.cache/**",
        ],
        // Add a small delay before triggering reloads
        aggregateTimeout: 300,
        // Poll less frequently (only if polling is enabled)
        poll: false,
      };
    }
    return config;
  },
};

export default nextConfig;
