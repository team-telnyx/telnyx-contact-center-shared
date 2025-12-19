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
  // Webpack configuration (only used when --webpack flag is explicitly set)
  webpack: (config, { isServer }) => {
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
    return config;
  },
};

export default nextConfig;
