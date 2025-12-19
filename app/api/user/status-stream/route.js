import { NextResponse } from "next/server";

// Server-Sent Events endpoint for real-time status updates
export async function GET(request) {
  // Create a readable stream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      const sendEvent = (event, data) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send connected event
      sendEvent("connected", { timestamp: new Date().toISOString() });

      // Send periodic ping to keep connection alive
      const pingInterval = setInterval(() => {
        try {
          sendEvent("ping", { timestamp: new Date().toISOString() });
        } catch (error) {
          clearInterval(pingInterval);
          controller.close();
        }
      }, 30000); // Ping every 30 seconds

      // Handle client disconnect
      request.signal.addEventListener("abort", () => {
        clearInterval(pingInterval);
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering for nginx
    },
  });
}
