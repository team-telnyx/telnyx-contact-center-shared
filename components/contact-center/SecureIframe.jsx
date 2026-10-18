"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Secure iframe component with sandbox attributes
 * Implements best practices for iframe security
 */
export function SecureIframe({ url, title, refreshKey = 0 }) {
  const tUi = useUiText();
  const iframeRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) {
      setError("No URL provided");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const iframe = iframeRef.current;
    if (!iframe) return;

    let loadTimeout;
    let hasLoaded = false;

    const handleLoad = () => {
      hasLoaded = true;
      // For Google Maps, give it more time to fully load
      const timeout = url.includes("google.com/maps/embed") ? 5000 : 3000;
      loadTimeout = setTimeout(() => {
        setLoading(false);
      }, timeout);
    };

    const handleError = () => {
      setError("Failed to load page");
      setLoading(false);
    };

    // Listen for messages from iframe (some sites send error messages).
    //
    // The origin is matched on its host exactly, or as a subdomain of
    // google.com. An `origin.includes("google.com")` test would also trust
    // https://google.com.attacker.example, a host anyone can register — and
    // this handler acts on messages from whoever sends them.
    const isGoogleOrigin = (origin) => {
      try {
        const host = new URL(origin).hostname.toLowerCase();
        return host === "google.com" || host.endsWith(".google.com");
      } catch {
        return false;
      }
    };
    const handleMessage = (event) => {
      if (
        isGoogleOrigin(event.origin) ||
        event.data?.error ||
        event.data?.type === "error"
      ) {
        if (!hasLoaded) {
          setError("Failed to load page. Please check the URL and API key.");
          setLoading(false);
        }
      }
    };

    // Check for 404 or other errors after a delay
    const checkForErrors = setTimeout(() => {
      if (!hasLoaded && iframe.contentWindow) {
        try {
          // Try to access iframe content - if it fails, might be a 404
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (iframeDoc) {
            // Check if page loaded successfully
            const body = iframeDoc.body;
            if (body && body.textContent) {
              // Check for common error indicators
              if (
                body.textContent.includes("404") ||
                body.textContent.includes("Not Found") ||
                body.textContent.includes("API key") ||
                body.textContent.includes("error")
              ) {
                setError(
                  "Failed to load page. Please verify the URL format and API key are correct.",
                );
                setLoading(false);
                return;
              }
            }
          }
        } catch (e) {
          // Cross-origin restrictions - can't check content
          // This is normal for external sites, so we'll assume it loaded
          if (!hasLoaded) {
            setLoading(false);
          }
        }
      }
    }, 2000);

    iframe.addEventListener("load", handleLoad);
    iframe.addEventListener("error", handleError);
    window.addEventListener("message", handleMessage);

    return () => {
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
      window.removeEventListener("message", handleMessage);
      if (loadTimeout) clearTimeout(loadTimeout);
      clearTimeout(checkForErrors);
    };
  }, [url, refreshKey]);

  // Check if URL is a Google Maps embed URL
  const isGoogleMapsEmbed = url.includes("google.com/maps/embed");

  // Build sandbox attributes - Google Maps needs fewer restrictions
  let sandboxValue;
  if (isGoogleMapsEmbed) {
    // Google Maps Embed API works better with minimal sandbox restrictions
    // Remove sandbox entirely for Google Maps to avoid 404 issues
    sandboxValue = undefined;
  } else {
    // For other sites, use restrictive sandbox
    sandboxValue = [
      "allow-same-origin",
      "allow-scripts",
      "allow-forms",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-presentation",
    ].join(" ");
  }

  // Use more permissive referrer policy for Google Maps
  const referrerPolicy = isGoogleMapsEmbed
    ? "no-referrer-when-downgrade"
    : "strict-origin-when-cross-origin";

  if (!url) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">{tUi("No URL provided")}</div>
    );
  }

  return (
    <div className="flex flex-col h-full relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
          <div className="text-center space-y-2">
            <Skeleton className="h-4 w-32 mx-auto" />
            <p className="text-xs text-muted-foreground">{tUi("Loading...")}</p>
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center justify-center h-full text-destructive p-4">
          <div className="text-center max-w-md">
            <p className="font-medium mb-2">{error}</p>
            {url.includes("google.com/maps/embed") && (
              <div className="text-xs text-muted-foreground space-y-1 mt-2 text-left max-w-md mx-auto">
                <p className="font-semibold mb-2">{tUi("Google Maps Embed API 404 Troubleshooting:")}</p>
                <ol className="list-decimal list-inside space-y-1.5">
                  <li>
                    <strong>{tUi("Enable Maps Embed API:")}</strong>{tUi(" Go to Google Cloud Console → APIs & Services → Enable \"Maps Embed API\"")}</li>
                  <li>
                    <strong>{tUi("Verify API Key:")}</strong>{tUi(" Ensure your API key is valid and not expired")}</li>
                  <li>
                    <strong>{tUi("Check API Key Restrictions:")}</strong>{tUi(" If restrictions are set, ensure your domain/IP is allowed")}</li>
                  <li>
                    <strong>{tUi("URL Format:")}</strong>{tUi(" Must be exactly: ")}<code className="bg-muted px-1 rounded">https://www.google.com/maps/embed/v1/MAP_MODE?key=API_KEY&PARAMETERS</code>
                  </li>
                  <li>
                    <strong>{tUi("Valid MAP_MODE values:")}</strong>{tUi(" place, directions, view, search, streetview")}</li>
                  <li>
                    <strong>{tUi("Required Parameters:")}</strong>{tUi(" Each mode requires specific parameters (e.g., place needs ")}<code className="bg-muted px-1 rounded">q</code>{tUi(" or ")}<code className="bg-muted px-1 rounded">place_id</code>)
                  </li>
                </ol>
                <div className="mt-3 pt-2 border-t">
                  <p className="font-semibold mb-1">{tUi("Example URLs:")}</p>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    <li>{tUi("Place: ")}<code className="bg-muted px-1 rounded">{tUi(".../place?key=KEY&q=New+York")}</code></li>
                    <li>{tUi("View: ")}<code className="bg-muted px-1 rounded">{tUi(".../view?key=KEY&center=40.7128,-74.0060&zoom=12")}</code></li>
                    <li>{tUi("Directions: ")}<code className="bg-muted px-1 rounded">{tUi(".../directions?key=KEY&origin=...&destination=...")}</code></li>
                  </ul>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3 break-all">{url}</p>
          </div>
        </div>
      )}
      <iframe
        key={`${url}-${refreshKey}`}
        ref={iframeRef}
        src={url}
        title={title || tUi("External Content")}
        className="w-full h-full border-0"
        {...(sandboxValue ? { sandbox: sandboxValue } : {})}
        referrerPolicy={referrerPolicy}
        loading="lazy"
        // Prevent clickjacking attempts
        style={{ isolation: "isolate" }}
      />
    </div>
  );
}
