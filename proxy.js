import { NextResponse } from "next/server";
import { withAuth } from "next-auth/middleware";
import { getToken } from "next-auth/jwt";
import { authorizePage } from "@/lib/authz/page-access-server.mjs";
import { deniedRedirectPath } from "@/lib/authz/page-access.mjs";

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

  // Widget bootstrap validates CORS against each published widget's origin
  // allowlist. The embedded frame and token-scoped session API are public.
  if (pathname === "/widget/frame" || pathname.startsWith("/api/widgets/") || pathname.startsWith("/api/widget-sessions/")) {
    return NextResponse.next();
  }

  // CORS support for API routes with allowed origins
  if (isApi) {
    const origin = request.headers.get("origin") || "";
    const envAllowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const defaultAllowed =
      process.env.NODE_ENV === "production"
        ? []
        : ["http://localhost:3000", "http://127.0.0.1:3000"];
    const allowedOrigins = new Set([...defaultAllowed, ...envAllowed]);
    const isAllowedOrigin = origin && allowedOrigins.has(origin);

    const setCors = (res) => {
      // Only allow requests from whitelisted origins
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
      }
      return res;
    };

    if (request.method === "OPTIONS") {
      if (origin && !isAllowedOrigin) {
        return new NextResponse(null, { status: 403 });
      }
      return setCors(new NextResponse(null, { status: 204 }));
    }

    return setCors(NextResponse.next());
  }

  if (isAsset || isNext || isFavicon) {
    return NextResponse.next();
  }

  // Page authorisation (RBAC Phase 3): a signed-in user may open a portal
  // path only when a role grants its screen. The decision comes from the
  // database (10 s per-instance cache) with the token snapshot as fallback;
  // refused requests land on the home page, which names the missing screen.
  try {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (token) {
      const decision = await authorizePage({ token, pathname, search: request.nextUrl.search });
      if (!decision.allowed) {
        console.warn(`[authz] page refused: ${pathname} (${decision.reason}, screen ${decision.screen || "unknown"})`);
        if (pathname !== "/") return NextResponse.redirect(new URL(deniedRedirectPath(decision.screen), request.url));
      }
      return NextResponse.next();
    }
  } catch (error) {
    // Authentication below still applies; authorisation is retried on the next request.
    console.error("[authz] page authorisation failed", error?.message || error);
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
    "/((?!signin|signup|forgot-password|reset-password|activate|health|_next|favicon.ico).*)",
  ],
};
