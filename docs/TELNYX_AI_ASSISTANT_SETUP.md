# Telnyx AI Assistant Setup for GMR Requirements

## Overview

To meet GMR's Virtual Voice Agent requirements, a **Telnyx AI Assistant** should be configured with the following capabilities:

---

## 1. Voice Configuration

```json
{
  "voice": {
    "voice_id": "Telnyx.NaturalHD.astra",
    "language": "en-US",
    "speech_rate": 1.0,
    "pitch": 1.0
  },
  "transcription": {
    "provider": "telnyx",
    "language": "en-US",
    "interim_results": true
  }
}
```

**For Spanish support**, configure dual-language with auto-detection:
- Primary: `en-US`
- Secondary: `es-MX` or `es-US`
- Use language detection on first utterance to switch

---

## 2. System Prompt Structure

The AI Assistant system prompt should include:

### A. Role Definition
```
You are a virtual voice agent for [Brand Name] air ambulance services. 
You handle customer calls professionally and efficiently.
```

### B. Intent Handling Rules
```
Available intents:
1. REQUEST_NEW_TRANSPORT - Collect all required information
2. CHECK_STATUS_ETA - Look up existing trip status
3. ASK_QUESTION - Answer from knowledge base
4. SPEAK_TO_HUMAN - Transfer to human agent

When multiple intents are detected, prioritize REQUEST_NEW_TRANSPORT 
unless the caller wants to verify no duplicate request exists.
```

### C. Slot Definitions (for REQUEST_NEW_TRANSPORT)
```
Required slots:
- caller_first_name: string
- caller_facility_name: string (validate via API)
- pickup_facility_name: string (validate via API)
- pickup_department: string (default: "Emergency Department")
- destination_facility_name: string (validate via API, optional if unknown)
- patient_first_name: string
- patient_last_name: string
- patient_dob: date (or approximate age if unavailable)
- patient_weight: number (convert kg to lbs if needed)
- reason_for_transport: string + enum classification
- iv_drip_count: number
- special_equipment: comma-separated list
- accompanying_person: boolean

Optional slots:
- caller_last_name
- pickup_room, pickup_bed
- destination_department, destination_room, destination_bed
- sending_physician, receiving_physician
- trip_notes
```

### D. Safety Questions
```
Always ask before completing:
1. "Has any other air service declined this flight for weather?" (yes/no/unknown)
2. "Are any other aircraft responding to your location?" (yes/no/unknown)
```

### E. Guardrails
```
- Never provide medical advice
- Never discuss pricing or billing details
- If asked about topics outside knowledge base, offer to transfer to human
- Detect frustration (sighs, raised voice, profanity) and offer human transfer
```

---

## 3. Knowledge Base (RAG) Setup

### PDF Document Ingestion
1. Upload company PDF to Telnyx Storage or S3
2. Configure RAG to index document content
3. Set retrieval parameters: top_k=5, similarity_threshold=0.7

### Website URL Access
1. Configure web scraping for `www.gmr.net`
2. Index key pages for Q&A retrieval
3. Update index periodically (weekly)

---

## 4. Tool/Function Definitions

### A. Facility Lookup
```json
{
  "name": "lookup_facility",
  "description": "Validate and lookup facility by name or address",
  "parameters": {
    "facility_name": { "type": "string" },
    "address": { "type": "string", "optional": true }
  }
}
```

### B. Trip Status Lookup
```json
{
  "name": "get_trip_status",
  "description": "Get status/ETA for active trip",
  "parameters": {
    "identifier": { "type": "string" },
    "identifier_type": { "type": "enum", "values": ["patient_name", "dob", "mrn", "room_number"] }
  }
}
```

### C. Create Trip Request
```json
{
  "name": "create_trip_request",
  "description": "Submit new transport request to Transport.net",
  "parameters": {
    "caller_info": { "type": "object" },
    "pickup_info": { "type": "object" },
    "destination_info": { "type": "object" },
    "patient_info": { "type": "object" },
    "transport_details": { "type": "object" },
    "safety_questions": { "type": "object" },
    "notes": { "type": "string" }
  }
}
```

---

## 5. Escalation Configuration

### Trigger Conditions
- Caller explicitly requests human agent
- Sentiment score drops below 30 for 2+ consecutive turns
- Profanity detected
- Slot validation fails 3+ times
- Trip creation timeout (>15 seconds)

### Handoff Data
Transfer to human agent should include:
- Full transcript
- AI-generated summary
- Filled slots (JSON)
- Reason for escalation
- Caller's phone number and identified facility

---

## 6. Webhook Integration

Configure webhooks for:
1. `assistant.conversation.started` - Log call start
2. `assistant.slot.filled` - Track slot collection progress
3. `assistant.tool.called` - Log API interactions
4. `assistant.conversation.ended` - Store transcript, summary, recording
5. `assistant.escalation.requested` - Trigger human agent routing

---

## 7. Testing & Red Teaming

Before production:
1. Test all intent paths (happy path + edge cases)
2. Test interruption handling mid-sentence
3. Test multi-intent scenarios
4. Test slot validation with invalid data
5. Test sentiment-triggered escalation
6. Test Spanish language switching
7. Red team for prompt injection, hallucination, off-topic responses

---

## Example API Call to Create Assistant

See the created assistant in `GMR_AIR_AMBULANCE_ASSISTANT.json` for a working example.
