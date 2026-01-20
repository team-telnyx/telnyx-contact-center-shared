import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * POST /api/agent-assist/generate-response
 * Generates a suggested response for a transcription using Telnyx AI chat completion with streaming
 */
export async function POST(request) {
  try {
    // Authenticate the user
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { transcript, articleContent } = body;

    if (!transcript || typeof transcript !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing or invalid transcript" },
        { status: 400 }
      );
    }

    if (!TELNYX_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "Server not configured" },
        { status: 500 }
      );
    }

    // Build the prompt for GPT-4o to generate a response
    const systemPrompt = `You are an expert contact center AI assistant. Your task is to generate a helpful, professional response for a customer service agent based on a customer's message and relevant knowledge base article.

Guidelines:
- Generate a concise response (maximum 5 sentences)
- Be professional, empathetic, and solution-oriented
- Use the knowledge base article content to provide accurate information
- Format your response using markdown (headings, lists, bold text where appropriate)
- Focus on helping the customer resolve their issue
- DO NOT include greetings like "Hello", "Hi", or "Dear"
- DO NOT include closings like "Best regards", "Sincerely", "Thank you", or signatures
- Start directly with the response content

Respond in markdown format.`;

    const userPrompt = `Customer message:
"${transcript}"

${articleContent ? `Relevant knowledge base article:\n${articleContent}` : ""}

Generate a suggested response for the agent (max 5 sentences, use markdown formatting):`;

    // Call Telnyx AI chat completion with streaming
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        model: "openai/gpt-4o",
        temperature: 0.7,
        max_tokens: 500,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[AgentAssist] Telnyx AI API error:",
        response.status,
        errorText
      );
      return NextResponse.json(
        {
          ok: false,
          error: `Telnyx AI API error: ${response.status}`,
        },
        { status: 502 }
      );
    }

    // Set up streaming response
    const stream = new ReadableStream({
      start(controller) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        function pump() {
          return reader.read().then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") {
                  controller.close();
                  return;
                }

                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify({ content })}\n\n`
                      )
                    );
                  }
                } catch (e) {
                  // Ignore parsing errors for incomplete chunks
                }
              }
            }

            return pump();
          });
        }

        return pump();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[AgentAssist] Error generating response:", error);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

