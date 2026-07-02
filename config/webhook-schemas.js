/**
 * Telnyx Webhook Payload Schemas
 *
 * Complete payload structures for all Telnyx Call Control webhook events
 * Extracted from openapi/telnyx.json
 *
 * Each schema includes:
 * - Field name
 * - Type (string, number, boolean, array, object)
 * - Description
 * - Example value (where available)
 */

// Webhook payload schemas mapped by event type
export const WEBHOOK_PAYLOAD_SCHEMAS = {
  "call.initiated": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    connection_codecs: {
      type: "string",
      description:
        "The list of comma-separated codecs enabled for the connection.",
      example: "G722,PCMU,PCMA",
    },
    offered_codecs: {
      type: "string",
      description: "The list of comma-separated codecs offered by caller.",
      example: "G722,PCMU,PCMA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    custom_headers: {
      type: "array",
      description: "Custom headers from sip invite",
      example: [
        { name: "head_1", value: "val_1" },
        { name: "head_2", value: "val_2" },
      ],
    },
    sip_headers: {
      type: "array",
      description: "User-to-User and Diversion headers from sip invite.",
      example: [
        { name: "User-to-User", value: "1234" },
        { name: "Diversion", value: "<sip:111@192.168.1.1>" },
      ],
    },
    shaken_stir_attestation: {
      type: "string",
      description: "SHAKEN/STIR attestation level.",
      example: "A",
    },
    shaken_stir_validated: {
      type: "boolean",
      description: "Whether attestation was successfully validated or not.",
      example: true,
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    caller_id_name: {
      type: "string",
      description: "Caller id.",
      example: "+35319605860",
    },
    call_screening_result: {
      type: "string",
      description: "Call screening result.",
      example: "spam_likely",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    direction: {
      type: "string",
      description: "Whether the call is `incoming` or `outgoing`.",
      example: "incoming",
    },
    state: {
      type: "string",
      description: "State received from a command.",
      example: "parked",
    },
    start_time: {
      type: "string",
      description: "ISO 8601 datetime of when the call started.",
      example: "2018-02-02T22:25:27.521992Z",
    },
    tags: {
      type: "array",
      description: "Array of tags associated to number.",
      example: ["tag-01", "tag-02"],
    },
  },

  "call.answered": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    custom_headers: {
      type: "array",
      description: "Custom headers set on answer command",
      example: [
        { name: "head_1", value: "val_1" },
        { name: "head_2", value: "val_2" },
      ],
    },
    sip_headers: {
      type: "array",
      description: "User-to-User and Diversion headers from sip invite.",
      example: [
        { name: "User-to-User", value: "1234" },
        { name: "Diversion", value: "<sip:111@192.168.1.1>" },
      ],
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    start_time: {
      type: "string",
      description: "ISO 8601 datetime of when the call started.",
      example: "2018-02-02T22:20:27.521992Z",
    },
    state: {
      type: "string",
      description: "State received from a command.",
      example: "answered",
    },
    tags: {
      type: "array",
      description: "Array of tags associated to number.",
      example: ["tag-01", "tag-02"],
    },
  },

  "call.hangup": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    custom_headers: {
      type: "array",
      description: "Custom headers set on answer command",
      example: [
        { name: "head_1", value: "val_1" },
        { name: "head_2", value: "val_2" },
      ],
    },
    sip_headers: {
      type: "array",
      description: "User-to-User and Diversion headers from sip invite.",
      example: [
        { name: "User-to-User", value: "1234" },
        { name: "Diversion", value: "<sip:111@192.168.1.1>" },
      ],
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    start_time: {
      type: "string",
      description: "ISO 8601 datetime of when the call started.",
      example: "2018-02-02T22:20:27.521992Z",
    },
    state: {
      type: "string",
      description: "State received from a command.",
      example: "hangup",
    },
    tags: {
      type: "array",
      description: "Array of tags associated to number.",
      example: ["tag-01", "tag-02"],
    },
    hangup_cause: {
      type: "string",
      description:
        "The reason the call was ended (`call_rejected`, `normal_clearing`, `originator_cancel`, `timeout`, `time_limit`, `user_busy`, `not_found` or `unspecified`).",
      example: "call_rejected",
    },
    hangup_source: {
      type: "string",
      description:
        "The party who ended the call (`callee`, `caller`, `unknown`).",
      example: "caller",
    },
    sip_hangup_cause: {
      type: "string",
      description:
        "The reason the call was ended (SIP response code). If the SIP response is unavailable (in inbound calls for example) this is set to `unspecified`.",
      example: "603",
    },
    call_quality_stats: {
      type: "object",
      description:
        "Call quality statistics aggregated from the CHANNEL_HANGUP_COMPLETE event. Only includes metrics that are available (filters out nil values). Returns nil if no metrics are available.",
    },
  },

  "call.bridged": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
  },

  "call.speak.started": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
  },

  "call.speak.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    status: {
      type: "string",
      description: "Reflects how the command ended.",
      example: "completed",
    },
  },

  "call.playback.started": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    media_url: {
      type: "string",
      description:
        "The audio URL being played back, if audio_url has been used to start.",
      example: "http://example.com/audio.wav",
    },
    media_name: {
      type: "string",
      description:
        "The name of the audio media file being played back, if media_name has been used to start.",
      example: "my_media_uploaded_to_media_storage_api",
    },
    overlay: {
      type: "boolean",
      description:
        "Whether the audio is going to be played in overlay mode or not.",
    },
  },

  "call.playback.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    media_url: {
      type: "string",
      description:
        "The audio URL being played back, if audio_url has been used to start.",
      example: "http://example.com/audio.wav",
    },
    media_name: {
      type: "string",
      description:
        "The name of the audio media file being played back, if media_name has been used to start.",
      example: "my_media_uploaded_to_media_storage_api",
    },
    overlay: {
      type: "boolean",
      description: "Whether the stopped audio was in overlay mode or not.",
    },
    status: {
      type: "string",
      description: "Reflects how command ended.",
      example: "completed",
    },
    status_detail: {
      type: "string",
      description: "Provides details in case of failure.",
      example:
        "Received curl error 22 HTTP error code 404 trying to fetch http://mediaurl.com.",
    },
  },

  "call.gather.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    digits: {
      type: "string",
      description: "The received DTMF digit or symbol.",
      example: "5503",
    },
    status: {
      type: "string",
      description: "Reflects how command ended.",
      example: "valid",
    },
  },

  "call.dtmf.received": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description: "Identifies the type of resource.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    digit: {
      type: "string",
      description: "The received DTMF digit or symbol.",
      example: "#",
    },
  },

  "call.recording.saved": {
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    recording_started_at: {
      type: "string",
      description: "ISO 8601 datetime of when recording started.",
      example: "2018-02-02T22:20:27.521992Z",
    },
    recording_ended_at: {
      type: "string",
      description: "ISO 8601 datetime of when recording ended.",
      example: "2018-02-02T22:25:27.521992Z",
    },
    channels: {
      type: "string",
      description:
        "Whether recording was recorded in `single` or `dual` channel.",
      example: "single",
    },
    recording_urls: {
      type: "object",
      description:
        "Recording URLs in requested format. These URLs are valid for 10 minutes. After 10 minutes, you may retrieve recordings via API using Reports -> Call Recordings documentation, or via Mission Control under Reporting -> Recordings.",
    },
    public_recording_urls: {
      type: "object",
      description:
        "Recording URLs in requested format. The URL is valid for as long as the file exists. For security purposes, this feature is activated on a per request basis. Please contact customer support with your Account ID to request activation.",
    },
  },

  "call.machine.detection.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    result: {
      type: "string",
      description: "Answering machine detection result.",
      example: "machine",
    },
  },

  "call.machine.greeting.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    result: {
      type: "string",
      description: "Answering machine greeting ended result.",
      example: "ended",
    },
  },

  "call.machine.premium.detection.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    result: {
      type: "string",
      description:
        "Premium Answering Machine Detection result. Possible values: human_residence, human_business, machine, silence, fax_detected, not_sure.",
      example: "machine",
    },
  },

  "call.machine.premium.greeting.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    result: {
      type: "string",
      description: "Premium Answering Machine Greeting ended result.",
      example: "beep_detected",
    },
  },

  "call.enqueued": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    queue: {
      type: "string",
      description: "The name of the queue",
      example: "support",
    },
    current_position: {
      type: "number",
      description: "Current position of the call in the queue.",
      example: 7,
    },
    queue_avg_wait_time_secs: {
      type: "number",
      description: "Average time call spends in the queue in seconds.",
      example: 60,
    },
  },

  "call.dequeued": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    queue: {
      type: "string",
      description: "The name of the queue",
      example: "support",
    },
    queue_position: {
      type: "number",
      description: "Last position of the call in the queue.",
      example: 7,
    },
    reason: {
      type: "string",
      description: "The reason for leaving the queue",
      example: "bridged",
    },
    wait_time_secs: {
      type: "number",
      description: "Time call spent in the queue in seconds.",
      example: 60,
    },
  },

  "call.fork.started": {
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_control_id: {
      type: "string",
      description: "Unique ID for controlling the call.",
      example: "v2:OycMASgvIjsGIAVEx8x3n9rYeKnUJx6a3V8VGhs5futnr17KZhujZA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    stream_type: {
      type: "string",
      description:
        "Type of media streamed. It can be either 'raw' or 'decrypted'.",
      example: "decrypted",
    },
  },

  "call.fork.stopped": {
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_control_id: {
      type: "string",
      description: "Unique ID for controlling the call.",
      example: "v2:OycMASgvIjsGIAVEx8x3n9rYeKnUJx6a3V8VGhs5futnr17KZhujZA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    stream_type: {
      type: "string",
      description:
        "Type of media streamed. It can be either 'raw' or 'decrypted'.",
      example: "decrypted",
    },
  },

  "call.refer.started": {
    call_control_id: {
      type: "string",
      description: "Unique ID for controlling the call.",
      example: "v2:OycMASgvIjsGIAVEx8x3n9rYeKnUJx6a3V8VGhs5futnr17KZhujZA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    sip_notify_response: {
      type: "number",
      description: "SIP NOTIFY event status for tracking the REFER attempt.",
      example: 100,
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
  },

  "call.refer.completed": {
    call_control_id: {
      type: "string",
      description: "Unique ID for controlling the call.",
      example: "v2:OycMASgvIjsGIAVEx8x3n9rYeKnUJx6a3V8VGhs5futnr17KZhujZA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    sip_notify_response: {
      type: "number",
      description: "SIP NOTIFY event status for tracking the REFER attempt.",
      example: 200,
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
  },

  "call.refer.failed": {
    call_control_id: {
      type: "string",
      description: "Unique ID for controlling the call.",
      example: "v2:OycMASgvIjsGIAVEx8x3n9rYeKnUJx6a3V8VGhs5futnr17KZhujZA",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    sip_notify_response: {
      type: "number",
      description: "SIP NOTIFY event status for tracking the REFER attempt.",
      example: 603,
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
  },

  "call.transcription": {
    call_control_id: {
      type: "string",
      description: "Unique identifier and token for controlling the call.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description:
        "Use this field to add state to every subsequent webhook. It must be a valid Base-64 encoded string.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    transcription_data: {
      type: "object",
      description: "Transcription data from the call",
      example: {
        is_final: true,
        transcript: "do you hear me well",
        transcription_track: "inbound",
      },
    },
  },

  "call.cost": {
    billed_duration_secs: {
      type: "number",
      description: "The number of seconds for which this call will be billed",
    },
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    connection_id: {
      type: "string",
      description: "Identifies the type of resource.",
      example: "7267xxxxxxxxxxxxxx",
    },
    cost_parts: {
      type: "array",
      description: "Breakdown of costs for this call",
    },
    total_cost: { type: "number", description: "The billed cost of the call" },
    status: {
      type: "string",
      description: "Reflects how command ended.",
      example: "valid",
    },
  },

  "call.recording.error": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    reason: {
      type: "string",
      description: "Indication that there was a problem recording the call.",
      example: "Internal server error",
    },
  },

  "call.recording.transcription.saved": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    calling_party_type: {
      type: "string",
      description: "The type of calling party connection.",
      example: "pstn",
    },
    recording_id: {
      type: "string",
      description:
        "ID that is unique to the recording session and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    recording_transcription_id: {
      type: "string",
      description:
        "ID that is unique to the transcription process and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    status: {
      type: "string",
      description: "The transcription status.",
      example: "completed",
    },
    transcription_text: {
      type: "string",
      description: "The transcribed text",
      example: "Hi!",
    },
  },

  // AI-related webhooks
  "call.ai_gather.ended": {
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ",
    },
    connection_id: {
      type: "string",
      description: "Telnyx connection ID used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description:
        "ID that is unique to the call and can be used to correlate webhook events.",
      example: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session and can be used to correlate webhook events. Call session is a group of related call legs that logically belong to the same phone call, e.g. an inbound and outbound leg of a transferred call.",
      example: "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
    },
    client_state: {
      type: "string",
      description: "State received from a command.",
      example: "aGF2ZSBhIG5pY2UgZGF5ID1d",
    },
    from: {
      type: "string",
      description: "Number or SIP URI placing the call.",
      example: "+35319605860",
    },
    to: {
      type: "string",
      description: "Destination number or SIP URI of the call.",
      example: "+13129457420",
    },
    message_history: {
      type: "array",
      description: "The history of the messages exchanged during the AI gather",
    },
    result: {
      type: "object",
      description:
        "The result of the AI gather, its type depends of the `parameters` provided in the command",
    },
    status: {
      type: "string",
      description: "Reflects how command ended.",
      example: "valid",
    },
  },

  "call.conversation.ended": {
    assistant_id: {
      type: "string",
      description: "Unique identifier of the assistant involved in the call.",
      example: "assistant-d9082b56-ba2d-4ad1-a50c-58661eb1463d",
    },
    call_control_id: {
      type: "string",
      description: "Call ID used to issue commands via Call Control API.",
      example: "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg",
    },
    connection_id: {
      type: "string",
      description:
        "Call Control App ID (formerly Telnyx connection ID) used in the call.",
      example: "7267xxxxxxxxxxxxxx",
    },
    call_leg_id: {
      type: "string",
      description: "ID that is unique to the call leg.",
      example: "cc29cce6-3c91-11f0-a8e5-02420aef3d20",
    },
    call_session_id: {
      type: "string",
      description:
        "ID that is unique to the call session (group of related call legs).",
      example: "cc29c8d6-3c91-11f0-aa7c-02420aef3d20",
    },
    client_state: {
      type: "string",
      description: "Base64-encoded state received from a command.",
      example:
        "g3QAAAACbQAAAAtkYXRhX2NlbnRlcm0AAAADY2gxbQAAAApkZXBsb3ltZW50bQAAAARiYXNl",
    },
    calling_party_type: {
      type: "string",
      description: "The type of calling party connection.",
      example: "sip",
    },
    conversation_id: {
      type: "string",
      description:
        "ID unique to the conversation or insight group generated for the call.",
      example: "0424805b-adc1-4ff8-9f95-e1de6883ecbe",
    },
    duration_sec: {
      type: "number",
      description: "Duration of the conversation in seconds.",
      example: 3,
    },
    from: {
      type: "string",
      description: "The caller's number or identifier.",
      example: "+13124287921",
    },
    to: {
      type: "string",
      description: "The callee's number or SIP address.",
      example:
        "jamesw@assistant-d9082b56-ba2d-4ad1-a50c-58661eb1463d.sip.telnyx.com",
    },
    llm_model: {
      type: "string",
      description: "The large language model used during the conversation.",
      example: "openai/gpt-4o",
    },
    stt_model: {
      type: "string",
      description: "The speech-to-text model used in the conversation.",
      example: "deepgram/flux",
    },
    tts_provider: {
      type: "string",
      description: "The text-to-speech provider used in the call.",
      example: "telnyx",
    },
    tts_model_id: {
      type: "string",
      description: "The model ID used for text-to-speech synthesis.",
      example: "Natural",
    },
    tts_voice_id: {
      type: "string",
      description: "Voice ID used for TTS.",
      example: "Marissa",
    },
  },

  // HTTP Request Action webhooks
  // Note: The response variable contains the parsed response body directly
  "http.success": {
    // Response body is stored directly in the response variable
    // Structure depends on the actual API response
  },

  "http.error": {
    // Response body is stored directly in the response variable
    // Structure depends on the actual API response
  },
};

/**
 * Get webhook schema for a specific event type
 * @param {string} eventType - The webhook event type (e.g., "call.initiated")
 * @returns {object|null} Schema object or null if not found
 */
export function getWebhookSchema(eventType) {
  return WEBHOOK_PAYLOAD_SCHEMAS[eventType] || null;
}

/**
 * Get all available paths from a webhook schema
 * @param {object} schema - The webhook schema object
 * @returns {array} Array of {path, type, description} objects
 */
export function getSchemaPath(schema) {
  if (!schema) return [];

  const examplePayload = {};
  const fieldMetadata = new Map();

  Object.entries(schema).forEach(([fieldName, fieldDef]) => {
    const path = `payload.${fieldName}`;
    examplePayload[fieldName] = Object.prototype.hasOwnProperty.call(fieldDef, "example")
      ? fieldDef.example
      : getExampleValueForSchemaField(fieldDef);
    fieldMetadata.set(path, fieldDef);
  });

  return extractPathsFromObject(examplePayload, "payload", 10).map((field) => {
    const metadata = fieldMetadata.get(field.path);
    return {
      ...field,
      description: metadata?.description || field.description || "",
    };
  });
}

function getExampleValueForSchemaField(fieldDef = {}) {
  switch (fieldDef.type) {
    case "array":
      return [];
    case "object":
      return {};
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "";
  }
}

/**
 * Extract all paths from a nested object (for HTTP response bodies)
 * @param {object} obj - The object to extract paths from
 * @param {string} prefix - The prefix for paths (e.g., "payload.body")
 * @param {number} maxDepth - Maximum depth to traverse (default: 5)
 * @returns {array} Array of {path, type, example} objects
 */
export function extractPathsFromObject(obj, prefix = "payload", maxDepth = 5) {
  const paths = [];

  function traverse(currentObj, currentPath, depth) {
    if (depth > maxDepth || !currentObj || typeof currentObj !== "object") {
      return;
    }

    // Add the current path if it's not the root
    if (currentPath !== prefix) {
      const exampleValue = currentObj;
      let type = "string";

      if (Array.isArray(currentObj)) {
        type = "array";
      } else if (typeof currentObj === "number") {
        type = "number";
      } else if (typeof currentObj === "boolean") {
        type = "boolean";
      } else if (typeof currentObj === "object" && currentObj !== null) {
        type = "object";
      }

      paths.push({
        path: currentPath,
        type,
        example: exampleValue,
      });
    }

    // Traverse nested properties
    if (
      typeof currentObj === "object" &&
      currentObj !== null &&
      !Array.isArray(currentObj)
    ) {
      Object.entries(currentObj).forEach(([key, value]) => {
        const newPath = currentPath ? `${currentPath}.${key}` : key;

        // Add leaf nodes
        if (value === null || typeof value !== "object") {
          let type = "string";
          if (typeof value === "number") {
            type = "number";
          } else if (typeof value === "boolean") {
            type = "boolean";
          } else if (value === null) {
            type = "null";
          }

          paths.push({
            path: newPath,
            type,
            example: value,
          });
        } else if (Array.isArray(value)) {
          paths.push({
            path: newPath,
            type: "array",
            example: value,
          });

          if (value.length > 0 && depth < maxDepth) {
            const sampleItem = value.find(
              (item) => item !== null && item !== undefined,
            );
            const itemPath = `${newPath}[]`;

            if (
              sampleItem !== undefined &&
              sampleItem !== null &&
              typeof sampleItem === "object" &&
              !Array.isArray(sampleItem)
            ) {
              traverse(sampleItem, itemPath, depth + 1);
            } else if (sampleItem !== undefined && sampleItem !== null) {
              paths.push({
                path: itemPath,
                type: Array.isArray(sampleItem) ? "array" : typeof sampleItem,
                example: sampleItem,
              });
            }
          }
        } else {
          // Traverse deeper for objects
          traverse(value, newPath, depth + 1);
        }
      });
    }
  }

  traverse(obj, prefix, 0);
  return paths;
}

/**
 * Get all available webhook event types
 * @returns {array} Array of event type strings
 */
export function getAvailableEvents() {
  return Object.keys(WEBHOOK_PAYLOAD_SCHEMAS);
}
