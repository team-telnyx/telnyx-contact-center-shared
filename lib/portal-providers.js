// Paths that render inside the application but are not the portal: the embedded
// widget frame and the stand-in customer page of the widget test page. They must
// not boot the portal's client providers, whose AuthProvider opens the shared
// `/api/user/status-stream` SSE. That connection stays open for the life of the
// document, and every extra one eats a per-origin socket (see the header of
// lib/status-stream-client.js), which starves the widget's own bootstrap and the
// rest of the application.
export const WIDGET_TEST_HOST_PATH = "/admin/widgets/test-host";
const PROVIDERLESS_PATHS = new Set(["/widget/frame"]);

export function needsPortalProviders(pathname) {
  return !PROVIDERLESS_PATHS.has(pathname)
    && pathname !== WIDGET_TEST_HOST_PATH
    && !pathname.startsWith(`${WIDGET_TEST_HOST_PATH}/`);
}
