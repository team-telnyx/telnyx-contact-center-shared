import { NextResponse } from "next/server";
import { withAuth } from "next-auth/middleware";
import { verifyAccessToken } from "./lib/jwt";

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // Block attempts to access sensitive files
  const suspiciousPatterns = [
    /\.env/i,
    /\.php$/i,
    /phpinfo/i,
    /\.bak$/i,
    /\.backup$/i,
    /\.swp$/i,
    /\.old$/i,
    /\.save$/i,
    /\.orig$/i,
    /\.tmp$/i,
    /~$/,
  ];

  if (suspiciousPatterns.some((pattern) => pattern.test(pathname))) {
    // Don't log the full pathname to avoid exposing sensitive information
    console.warn(
      `[SECURITY] Blocked suspicious request pattern from ${
        request.ip || "unknown IP"
      }`
    );
    return new NextResponse("Not Found", { status: 404 });
  }

  const isAsset = /\.[^/]+$/.test(pathname);
  const isNext = pathname.startsWith("/_next");
  const isFavicon = pathname === "/favicon.ico";
  const isApi = pathname.startsWith("/api");

  // CORS support for API routes with allowed origins
  if (isApi) {
    const origin = request.headers.get("origin") || "";
    const envAllowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const defaultAllowed = [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://cc.domain.com",
      "https://app.domain.com",
    ];
    const allowedOrigins = new Set([...defaultAllowed, ...envAllowed]);

    const setCors = (res) => {
      // Only allow requests from whitelisted origins
      const isAllowedOrigin = origin && allowedOrigins.has(origin);

      if (isAllowedOrigin) {
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Vary", "Origin");
        res.headers.set("Access-Control-Allow-Credentials", "true");
        res.headers.set(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        );
        res.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Requested-With, telnyx-ai-api-key"
        );
      } else if (request.method === "OPTIONS") {
        // Handle preflight OPTIONS requests
        res.headers.set("Access-Control-Allow-Origin", "*");
        res.headers.set(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        );
        res.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Requested-With, telnyx-ai-api-key"
        );
      }
      return res;
    };

    if (request.method === "OPTIONS") {
      return setCors(new NextResponse(null, { status: 204 }));
    }

    return setCors(NextResponse.next());
  }

  if (isAsset || isNext || isFavicon) {
    return NextResponse.next();
  }

  // Local credentials logins use the app auth endpoint, which issues the
  // httpOnly `session` cookie consumed by /api/auth/me. Accept that same
  // cookie for route protection before falling back to NextAuth, otherwise
  // a successful custom login is immediately redirected back to /signin.
  const customSessionCookie = request.cookies.get("session");
  if (customSessionCookie?.value) {
    try {
      const customSessionPayload = await verifyAccessToken(customSessionCookie?.value);
      if (customSessionPayload?.sub) {
        return NextResponse.next();
      }
    } catch (_) {
      // Invalid custom session cookies fall through to the existing NextAuth guard.
    }
  }

  // Use withAuth to protect routes
  return withAuth(
    function middleware(req) {
      return NextResponse.next();
    },
    {
      pages: {
        signIn: "/signin",
      },
    }
  )(request);
}

export const config = {
  matcher: [
    "/((?!api|signin|signup|forgot-password|reset-password|activate|health|_next|favicon.ico).*)",
  ],
};
