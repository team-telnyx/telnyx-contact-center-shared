/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configure body size limit for Server Actions (for profile picture uploads)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  allowedDevOrigins: ["tunnel.demotelnyx.com", "api.tokaj.synology.me"],
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
  // Turbopack configuration to prevent unnecessary file watching
  turbopack: {
    // Ignore files and directories that shouldn't trigger reloads
    resolveAlias: {},
    // Configure file watching to exclude unnecessary directories
    // This prevents auto-refresh when files in these directories change
  },
  // Completely disable automatic reloads in dev mode
  // This prevents modals/sheets from closing during testing
  onDemandEntries: {
    // Keep pages in memory indefinitely to prevent reloads
    maxInactiveAge: 25 * 60 * 60 * 1000, // 25 hours (effectively never)
    pagesBufferLength: 100, // Keep many pages in memory
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
    // In dev mode, configure file watching to prevent unnecessary reloads
    if (dev) {
      // Configure watchOptions to be very restrictive
      // Only watch actual source files, ignore everything else
      config.watchOptions = {
        ignored: [
          // Ignore build and cache directories
          "**/node_modules/**",
          "**/.next/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
          "**/coverage/**",
          // Ignore logs and system files
          "**/*.log",
          "**/.DS_Store",
          "**/yarn-error.log",
          "**/npm-debug.log",
          "**/.yarn/**",
          // Ignore documentation and planning files
          "**/plan/**",
          "**/docs/**",
          // Ignore static assets (changes here shouldn't trigger reload)
          "**/public/**",
          // Ignore config and lock files
          "**/.env*",
          "**/yarn.lock",
          "**/package-lock.json",
          // Ignore test files
          "**/tests/**",
          "**/test/**",
          "**/*.test.*",
          "**/*.spec.*",
          // Ignore scripts directory
          "**/scripts/**",
          // Ignore docker files
          "**/docker/**",
          // Ignore any markdown files
          "**/*.md",
        ],
        // Aggregate multiple changes into a single rebuild
        // Increased timeout significantly to prevent rapid reloads
        aggregateTimeout: 10000, // Wait 10 seconds after the last change before rebuilding
        // Use native file watching (not polling) for better performance
        poll: false,
        // Follow symlinks (usually not needed, but can cause issues if enabled)
        followSymlinks: false,
      };

      // Disable file watching entirely if FAST_REFRESH is explicitly false
      // This will require manual server restart for changes
      if (process.env.FAST_REFRESH === "false") {
        // Set watch to false to completely disable file watching
        // Note: This means you'll need to manually restart the server for changes
        // Uncomment the line below if you want to completely disable watching:
        // config.watch = false;
        // Instead, we'll just make the watchOptions very restrictive above
        // and rely on FAST_REFRESH=false to prevent actual refreshes
      }
    }
    return config;
  },
};

export default nextConfig;
