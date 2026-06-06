import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(request, context) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { params } = await context;
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Missing assistant id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Get assistant details first
    const assistantRes = await fetch(
      buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!assistantRes.ok) {
      const text = await assistantRes.text();
      let statusCode = 502;

      // If assistant not found, return 404 instead of 502
      if (assistantRes.status === 404) {
        statusCode = 404;
      }

      return NextResponse.json(
        {
          ok: false,
          error: `Telnyx API error: ${assistantRes.status} ${text}`,
        },
        { status: statusCode, headers: { "Cache-Control": "no-store" } }
      );
    }

    const assistantData = await assistantRes.json();
    const assistant = assistantData?.data || assistantData;

    const voiceNumbers = [];
    const messagingNumbers = [];

    // Get voice numbers from telephony_settings.default_texml_app_id
    if (assistant?.telephony_settings?.default_texml_app_id) {
      try {
        const texmlAppId = assistant.telephony_settings.default_texml_app_id;

        // Get phone numbers associated with this TeXML app
        const phoneNumbersRes = await fetch(
          buildTelnyxV2Url(
            `/phone_numbers?filter[connection_id]=${encodeURIComponent(
              texmlAppId
            )}`
          ),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            cache: "no-store",
          }
        );

        if (phoneNumbersRes.ok) {
          const phoneNumbersData = await phoneNumbersRes.json();
          const numbers = phoneNumbersData?.data || [];
          voiceNumbers.push(
            ...numbers.map((num) => ({
              id: num.id,
              phone_number: num.phone_number,
              display_name: num.phone_number,
            }))
          );
        }
      } catch (err) {
        console.error("Error fetching voice numbers:", err);
      }
    }

    // Get messaging numbers from messaging_settings.default_messaging_profile_id
    if (assistant?.messaging_settings?.default_messaging_profile_id) {
      try {
        const messagingProfileId =
          assistant.messaging_settings.default_messaging_profile_id;

        // Get phone numbers associated with this messaging profile
        const phoneNumbersRes = await fetch(
          buildTelnyxV2Url(
            `/phone_numbers?filter[messaging_profile_id]=${encodeURIComponent(
              messagingProfileId
            )}`
          ),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            cache: "no-store",
          }
        );

        if (phoneNumbersRes.ok) {
          const phoneNumbersData = await phoneNumbersRes.json();
          const numbers = phoneNumbersData?.data || [];
          messagingNumbers.push(
            ...numbers.map((num) => ({
              id: num.id,
              phone_number: num.phone_number,
              display_name: num.phone_number,
            }))
          );
        }
      } catch (err) {
        console.error("Error fetching messaging numbers:", err);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        voice_numbers: voiceNumbers,
        messaging_numbers: messagingNumbers,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("Error fetching phone numbers:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

