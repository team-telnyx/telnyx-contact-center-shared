/**
 * Voice Flow Node Type Definitions
 * Based on Telnyx Voice API OpenAPI specification
 */

export const NODE_CATEGORIES = {
  INITIATOR: "initiator",
  CALL_CONTROL: "call_control",
  AUDIO_OUTPUT: "audio_output",
  INPUT_COLLECTION: "input_collection",
  AI_INTEGRATION: "ai_integration",
  RECORDING: "recording",
  TRANSCRIPTION: "transcription",
  STREAMING: "streaming",
  LOGICAL: "logical",
  INTEGRATION: "integration",
};

export const NODE_COLORS = {
  [NODE_CATEGORIES.INITIATOR]: "rgb(59 130 246)", // blue-500
  [NODE_CATEGORIES.CALL_CONTROL]: "rgb(34 197 94)", // green-500
  [NODE_CATEGORIES.AUDIO_OUTPUT]: "rgb(168 85 247)", // purple-500
  [NODE_CATEGORIES.INPUT_COLLECTION]: "rgb(249 115 22)", // orange-500
  [NODE_CATEGORIES.AI_INTEGRATION]: "rgb(139 92 246)", // violet-500
  [NODE_CATEGORIES.RECORDING]: "rgb(236 72 153)", // pink-500
  [NODE_CATEGORIES.TRANSCRIPTION]: "rgb(6 182 212)", // cyan-500
  [NODE_CATEGORIES.STREAMING]: "rgb(239 68 68)", // red-500
  [NODE_CATEGORIES.LOGICAL]: "rgb(234 179 8)", // yellow-500
  [NODE_CATEGORIES.INTEGRATION]: "rgb(20 184 166)", // teal-500
};

export const VOICE_FLOW_NODES = {
  // INITIATOR NODES
  incoming_call: {
    id: "incoming_call",
    category: NODE_CATEGORIES.INITIATOR,
    label: "Incoming Call",
    icon: "IconPhoneIncoming",
    color: NODE_COLORS[NODE_CATEGORIES.INITIATOR],
    description: "Trigger flow when a call is received on a voice application",
    telnyxAction: "incoming_call_trigger",
    telnyxEndpoint: null, // This is a webhook trigger, not an action
    inputs: 0,
    outputs: 1,
    outputLabels: ["Call Received"],
    outputEvents: ["call.initiated"],
    config: {
      voice_application_id: {
        type: "voice_app_select",
        label: "Voice Application",
        required: false,
        description: "Your account's voice application.",
        placeholder: "Voice application...",
      },
      webhook_url: {
        type: "string",
        label: "Webhook URL",
        required: false,
        readOnly: true,
        description: "Your voice application webhook URL",
      },
    },
  },

  http_request: {
    id: "http_request",
    category: NODE_CATEGORIES.INITIATOR,
    label: "HTTP Request",
    icon: "IconWebhook",
    color: NODE_COLORS[NODE_CATEGORIES.INITIATOR],
    description: "Trigger flow via HTTP POST/GET request",
    telnyxAction: "http_request_trigger",
    telnyxEndpoint: null, // This is an HTTP trigger, not an action
    inputs: 0,
    outputs: 1,
    outputLabels: ["Request Received"],
    outputEvents: ["http.request"],
    config: {
      http_method: {
        type: "select",
        label: "HTTP Method",
        required: true,
        default: "POST",
        options: [
          { value: "POST", label: "POST" },
          { value: "GET", label: "GET" },
        ],
        description: "HTTP method that will trigger this flow",
      },
      endpoint_path: {
        type: "string",
        label: "Endpoint Path",
        required: false,
        readOnly: true,
        description: "Unique endpoint path for this flow trigger",
        placeholder: "/api/voice/flows/trigger/{flow-id}",
      },
      auth_required: {
        type: "boolean",
        label: "Require Authentication",
        required: false,
        default: false,
        description: "Require authentication token in request headers",
      },
    },
  },

  // CALL CONTROL NODES
  dial: {
    id: "dial",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Dial Number",
    icon: "IconPhoneOutgoing",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Initiate an outbound call",
    telnyxAction: "create_call",
    telnyxEndpoint: "/v2/calls",
    inputs: 1,
    outputs: 7,
    outputLabels: [
      "Call Initiated",
      "Call Answered",
      "Call Hangup",
      "AMD Detection Ended",
      "AMD Premium Detection Ended",
      "AMD Greeting Ended",
      "AMD Premium Greeting Ended",
    ],
    outputEvents: [
      "call.initiated",
      "call.answered",
      "call.hangup",
      "call.machine.detection.ended",
      "call.machine.premium.detection.ended",
      "call.machine.greeting.ended",
      "call.machine.premium.greeting.ended",
    ],
    outputDescriptions: [
      "Triggered when call is initiated (call.initiated event)",
      "Triggered when call is answered (call.answered event)",
      "Triggered when call hangs up (call.hangup event)",
      "Triggered when standard AMD detection ends (call.machine.detection.ended event)",
      "Triggered when premium AMD detection ends (call.machine.premium.detection.ended event)",
      "Triggered when machine greeting ends (call.machine.greeting.ended event)",
      "Triggered when premium machine greeting ends (call.machine.premium.greeting.ended event)",
    ],
    customEditor: "DialNodeEditor",
    config: {
      to: {
        type: "string",
        label: "To Number",
        required: true,
        placeholder: "+15551234567",
        description: "The DID or SIP URI to dial",
      },
      from: {
        type: "string",
        label: "From Number",
        required: true,
        placeholder: "+15559876543",
        description: "The `from` number to be used as the caller id",
      },
      connection_id: {
        type: "string",
        label: "Connection ID",
        required: false,
        readOnly: true,
        description: "The ID of the Call Control App",
      },
      webhook_url: {
        type: "string",
        label: "Webhook URL",
        required: false,
        readOnly: true,
        description: "URL for webhooks related to this call (auto-generated)",
      },
      from_display_name: {
        type: "string",
        label: "From Display Name",
        required: false,
        description: "The caller ID name to be used for the call",
      },
      audio_url: {
        type: "string",
        label: "Audio URL",
        required: false,
        description:
          "The URL of the audio file to play when the call is answered",
      },
      media_name: {
        type: "string",
        label: "Media Name",
        required: false,
        description: "The name of the media file to play",
      },
      timeout_secs: {
        type: "number",
        label: "Timeout (seconds)",
        required: false,
        description:
          "The number of seconds to wait for the call to be answered",
      },
      time_limit_secs: {
        type: "number",
        label: "Time Limit (seconds)",
        required: false,
        description: "The maximum duration of the call in seconds",
      },
      link_to: {
        type: "string",
        label: "Link To",
        required: false,
        description: "The call control ID to link this call to",
      },
      bridge_intent: {
        type: "string",
        label: "Bridge Intent",
        required: false,
        description: "The intent for bridging the call",
      },
      bridge_on_answer: {
        type: "boolean",
        label: "Bridge On Answer",
        required: false,
        description: "Whether to bridge the call when it is answered",
      },
      park_after_unbridge: {
        type: "boolean",
        label: "Park After Unbridge",
        required: false,
        description: "Whether to park the call after unbridging",
      },
      record: {
        type: "boolean",
        label: "Record",
        required: false,
        description: "Whether to record the call",
      },
      record_channels: {
        type: "select",
        label: "Record Channels",
        required: false,
        options: [
          { value: "single", label: "Single" },
          { value: "dual", label: "Dual" },
        ],
        description: "The recording channels",
      },
      record_format: {
        type: "select",
        label: "Record Format",
        required: false,
        options: [
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
        ],
        description: "The recording format",
      },
      record_max_length: {
        type: "number",
        label: "Record Max Length (seconds)",
        required: false,
        description: "The maximum length of the recording in seconds",
      },
      record_timeout_secs: {
        type: "number",
        label: "Record Timeout (seconds)",
        required: false,
        description: "The timeout for recording in seconds",
      },
      record_track: {
        type: "select",
        label: "Record Track",
        required: false,
        options: [
          { value: "inbound", label: "Inbound" },
          { value: "outbound", label: "Outbound" },
          { value: "both", label: "Both" },
        ],
        description: "Which track(s) to record",
      },
      supervise_call_control_id: {
        type: "string",
        label: "Supervise Call Control ID",
        required: false,
        description: "The call control ID to supervise",
      },
      supervisor_role: {
        type: "select",
        label: "Supervisor Role",
        required: false,
        options: [
          { value: "barge", label: "Barge" },
          { value: "whisper", label: "Whisper" },
          { value: "monitor", label: "Monitor" },
        ],
        description: "The supervisor role for the call",
      },
      sip_region: {
        type: "string",
        label: "SIP Region",
        required: false,
        description: "The SIP region for the call",
      },
      answering_machine_detection: {
        type: "select",
        label: "Answering Machine Detection",
        required: false,
        options: [
          { value: "disabled", label: "Disabled" },
          { value: "premium", label: "Premium" },
          { value: "detect", label: "Detect" },
          { value: "detect_beep", label: "Detect Beep" },
          { value: "detect_words", label: "Detect Words" },
          { value: "greeting_end", label: "Greeting End" },
        ],
        description:
          "Enables Answering Machine Detection. Premium detection provides detailed results. Standard detection determines if answered by human or machine.",
      },
      answering_machine_detection_config: {
        type: "object",
        label: "AMD Configuration",
        required: false,
        description:
          "Optional configuration parameters to modify answering machine detection performance",
      },
      stream_url: {
        type: "string",
        label: "Stream URL",
        required: false,
        description:
          "The destination WebSocket address where the stream is going to be delivered",
      },
      stream_track: {
        type: "select",
        label: "Stream Track",
        required: false,
        options: [
          { value: "inbound_track", label: "Inbound Track" },
          { value: "outbound_track", label: "Outbound Track" },
          { value: "both_tracks", label: "Both Tracks" },
        ],
        description: "Specifies which track should be streamed",
      },
      stream_codec: {
        type: "select",
        label: "Stream Codec",
        required: false,
        options: [
          { value: "PCMU", label: "PCMU" },
          { value: "PCMA", label: "PCMA" },
          { value: "G722", label: "G722" },
          { value: "OPUS", label: "OPUS" },
          { value: "AMR-WB", label: "AMR-WB" },
          { value: "L16", label: "L16" },
        ],
        description: "Specifies the codec to be used for the streamed audio",
      },
      stream_bidirectional_mode: {
        type: "select",
        label: "Bidirectional Stream Mode",
        required: false,
        options: [
          { value: "mp3", label: "MP3" },
          { value: "rtp", label: "RTP" },
        ],
        description: "Configures method of bidirectional streaming (mp3, rtp)",
      },
      stream_bidirectional_codec: {
        type: "select",
        label: "Bidirectional Stream Codec",
        required: false,
        options: [
          { value: "PCMU", label: "PCMU" },
          { value: "PCMA", label: "PCMA" },
          { value: "G722", label: "G722" },
          { value: "OPUS", label: "OPUS" },
          { value: "AMR-WB", label: "AMR-WB" },
          { value: "L16", label: "L16" },
        ],
        description: "Indicates codec for bidirectional streaming RTP payloads",
      },
      stream_bidirectional_target_legs: {
        type: "select",
        label: "Bidirectional Stream Target Legs",
        required: false,
        options: [
          { value: "both", label: "Both" },
          { value: "self", label: "Self" },
          { value: "opposite", label: "Opposite" },
        ],
        description:
          "Specifies which call legs should receive the bidirectional stream audio",
      },
      stream_bidirectional_sampling_rate: {
        type: "number",
        label: "Bidirectional Stream Sampling Rate",
        required: false,
        description: "Audio sampling rate",
      },
      stream_establish_before_call_originate: {
        type: "boolean",
        label: "Establish WebSocket Before Call Originate",
        required: false,
        description:
          "Establish websocket connection before dialing the destination",
      },
      send_silence_when_idle: {
        type: "boolean",
        label: "Send Silence When Idle",
        required: false,
        description:
          "Generate silence RTP packets when no transmission available",
      },
      // custom_headers and sip_headers will be handled by the custom editor
    },
  },

  answer: {
    id: "answer",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Answer Call",
    icon: "IconPhoneCall",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Answer an incoming call",
    telnyxAction: "answer",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/answer",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Answered"],
    outputEvents: ["call.answered"],
    customEditor: "AnswerNodeEditor",
    config: {
      billing_group_id: {
        type: "string",
        label: "Billing Group ID",
        required: false,
        description: "Use this field to set the Billing Group ID for the call",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
      webhook_url: {
        type: "string",
        label: "Webhook URL",
        required: false,
        description: "URL to receive webhooks for this call",
      },
      send_silence_when_idle: {
        type: "boolean",
        label: "Send Silence When Idle",
        required: false,
        default: false,
        description:
          "Generate silence RTP packets when no transmission available",
      },
      record: {
        type: "select",
        label: "Record",
        required: false,
        options: [{ value: "record-from-answer", label: "Record From Answer" }],
        description:
          "Start recording automatically after an event. Disabled by default.",
      },
      record_channels: {
        type: "select",
        label: "Record Channels",
        required: false,
        default: "dual",
        options: [
          { value: "single", label: "Single" },
          { value: "dual", label: "Dual" },
        ],
        description:
          "Defines which channel should be recorded ('single' or 'dual') when record is specified.",
      },
      record_format: {
        type: "select",
        label: "Record Format",
        required: false,
        default: "mp3",
        options: [
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
        ],
        description:
          "Defines the format of the recording ('wav' or 'mp3') when record is specified.",
      },
      record_max_length: {
        type: "number",
        label: "Record Max Length (seconds)",
        required: false,
        default: 0,
        min: 0,
        max: 43200,
        description:
          "Defines the maximum length for the recording in seconds when record is specified. The minimum value is 0. The maximum value is 43200. The default value is 0 (infinite).",
      },
      record_timeout_secs: {
        type: "number",
        label: "Record Timeout (seconds)",
        required: false,
        default: 0,
        min: 0,
        description:
          "The number of seconds that Telnyx will wait for the recording to be stopped if silence is detected when record is specified. The timer only starts when the speech is detected. Please note that call transcription is used to detect silence and the related charge will be applied. The minimum value is 0. The default value is 0 (infinite).",
      },
      record_track: {
        type: "select",
        label: "Record Track",
        required: false,
        default: "both",
        options: [
          { value: "inbound", label: "Inbound" },
          { value: "outbound", label: "Outbound" },
          { value: "both", label: "Both" },
        ],
        description:
          "The audio track to be recorded. Can be either 'both', 'inbound' or 'outbound'. If only single track is specified ('inbound', 'outbound'), 'channels' configuration is ignored and it will be recorded as mono (single channel).",
      },
      record_trim: {
        type: "select",
        label: "Record Trim",
        required: false,
        options: [{ value: "trim-silence", label: "Trim Silence" }],
        description:
          "When set to 'trim-silence', silence will be removed from the beginning and end of the recording.",
      },
      record_custom_file_name: {
        type: "string",
        label: "Record Custom File Name",
        required: false,
        maxLength: 40,
        description:
          "The custom recording file name to be used instead of the default call_leg_id. Telnyx will still add a Unix timestamp suffix.",
      },
    },
  },

  hangup: {
    id: "hangup",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Hangup Call",
    icon: "IconPhoneOff",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "End the call",
    telnyxAction: "hangup",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/hangup",
    inputs: 1,
    outputs: 0,
    outputLabels: [],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description: "Use this field to avoid duplicate commands",
      },
    },
  },

  reject: {
    id: "reject",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Reject Call",
    icon: "IconX",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Reject an incoming call",
    telnyxAction: "reject",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/reject",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Rejected"],
    outputEvents: ["call.hangup"],
    outputDescriptions: ["Call was rejected (call.hangup)"],
    config: {
      cause: {
        type: "select",
        label: "Rejection Cause",
        required: true,
        default: "CALL_REJECTED",
        options: [
          { value: "CALL_REJECTED", label: "Call Rejected" },
          { value: "USER_BUSY", label: "User Busy" },
        ],
        description: "Cause for call rejection",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
    },
  },

  noise_suppression_start: {
    id: "noise_suppression_start",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Noise Suppression Start",
    icon: "IconVolume",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Start noise suppression on the call (BETA)",
    telnyxAction: "noise_suppression_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/suppression_start",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Started"],
    outputEvents: [],
    outputDescriptions: ["Noise suppression was started"],
    config: {
      direction: {
        type: "select",
        label: "Direction",
        required: false,
        default: "inbound",
        options: [
          { value: "inbound", label: "Inbound" },
          { value: "outbound", label: "Outbound" },
          { value: "both", label: "Both" },
        ],
        description: "The direction of the audio stream to be noise suppressed",
      },
      noise_suppression_engine: {
        type: "select",
        label: "Engine",
        required: false,
        default: "Denoiser",
        options: [
          { value: "Denoiser", label: "Denoiser" },
          { value: "DeepFilterNet", label: "DeepFilterNet" },
        ],
        description: "The engine to use for noise suppression",
      },
      attenuation_limit: {
        type: "number",
        label: "Attenuation Limit",
        required: false,
        default: 100,
        min: 0,
        max: 100,
        description:
          "The attenuation limit for noise suppression (0-100). Only applicable for DeepFilterNet engine.",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
    },
  },

  noise_suppression_stop: {
    id: "noise_suppression_stop",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Noise Suppression Stop",
    icon: "IconVolumeOff",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Stop noise suppression on the call (BETA)",
    telnyxAction: "noise_suppression_stop",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/suppression_stop",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Stopped"],
    outputEvents: [],
    outputDescriptions: ["Noise suppression was stopped"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
    },
  },

  switch_supervisor_role: {
    id: "switch_supervisor_role",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Switch Supervisor Role",
    icon: "IconUser",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description:
      "Switch the supervisor role for a bridged call. This allows switching between different supervisor modes during an active call",
    telnyxAction: "switch_supervisor_role",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/switch_supervisor_role",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Switched"],
    outputEvents: [],
    outputDescriptions: ["Supervisor role was switched"],
    config: {
      role: {
        type: "select",
        label: "Supervisor Role",
        required: true,
        default: "barge",
        options: [
          {
            value: "barge",
            label: "Barge",
            description: "Allows speaking to both parties",
          },
          {
            value: "whisper",
            label: "Whisper",
            description: "Allows speaking to caller only",
          },
          {
            value: "monitor",
            label: "Monitor",
            description: "Allows listening only",
          },
        ],
        description:
          "The supervisor role to switch to. 'barge' allows speaking to both parties, 'whisper' allows speaking to caller only, 'monitor' allows listening only.",
      },
    },
  },

  transfer: {
    id: "transfer",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Transfer Call",
    icon: "IconPhoneCall",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Transfer the call to another number",
    telnyxAction: "transfer",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/transfer",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Transferred", "Failed"],
    outputEvents: ["call.transfer.completed", "call.transfer.failed"],
    outputDescriptions: [
      "Call was successfully transferred",
      "Transfer failed or was rejected",
    ],
    config: {
      to: {
        type: "string",
        label: "To Number",
        required: true,
        placeholder: "+15551234567 or sip:user@domain.com",
        description: "The DID or SIP URI to transfer the call to",
      },
      from: {
        type: "string",
        label: "From Number",
        required: false,
        description: "The `from` number to be used as the caller id",
      },
      from_display_name: {
        type: "string",
        label: "From Display Name",
        required: false,
        description:
          "The `from_display_name` string to be used as the caller id name",
      },
      timeout_secs: {
        type: "number",
        label: "Timeout (seconds)",
        required: false,
        default: 60,
        description:
          "The number of seconds to wait for the call to be answered",
      },
    },
  },

  bridge: {
    id: "bridge",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Bridge Calls",
    icon: "IconLink",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Bridge two call control calls",
    telnyxAction: "bridge",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/bridge",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Bridged", "Failed"],
    outputEvents: ["call.bridged", "call.bridge.failed"],
    outputDescriptions: [
      "Calls were successfully bridged",
      "Bridge failed or connection error",
    ],
    customEditor: "BridgeNodeEditor",
    config: {
      call_control_id: {
        type: "string",
        label: "Call Control ID",
        required: false,
        description:
          "The Call Control ID of the call you want to bridge with, can't be used together with queue parameter or video_room_id parameter",
      },
      queue: {
        type: "string",
        label: "Queue",
        required: false,
        placeholder: "support",
        description:
          "The name of the queue you want to bridge with, can't be used together with call_control_id parameter or video_room_id parameter",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
      park_after_unbridge: {
        type: "select",
        label: "Park After Unbridge",
        required: false,
        options: [{ value: "self", label: "Self" }],
        description:
          "Specifies behavior after the bridge ends. If supplied with the value 'self', the current leg will be parked after unbridge. If not set, the default behavior is to hang up the leg.",
      },
      play_ringtone: {
        type: "boolean",
        label: "Play Ringtone",
        required: false,
        default: false,
        description:
          "Specifies whether to play a ringtone if the call you want to bridge with has not yet been answered",
      },
      ringtone: {
        type: "select",
        label: "Ringtone",
        required: false,
        default: "us",
        options: [
          { value: "at", label: "Austria" },
          { value: "au", label: "Australia" },
          { value: "be", label: "Belgium" },
          { value: "bg", label: "Bulgaria" },
          { value: "br", label: "Brazil" },
          { value: "ch", label: "Switzerland" },
          { value: "cl", label: "Chile" },
          { value: "cn", label: "China" },
          { value: "cz", label: "Czech Republic" },
          { value: "de", label: "Germany" },
          { value: "dk", label: "Denmark" },
          { value: "ee", label: "Estonia" },
          { value: "es", label: "Spain" },
          { value: "fi", label: "Finland" },
          { value: "fr", label: "France" },
          { value: "gr", label: "Greece" },
          { value: "hu", label: "Hungary" },
          { value: "il", label: "Israel" },
          { value: "in", label: "India" },
          { value: "it", label: "Italy" },
          { value: "jp", label: "Japan" },
          { value: "lt", label: "Lithuania" },
          { value: "mx", label: "Mexico" },
          { value: "my", label: "Malaysia" },
          { value: "nl", label: "Netherlands" },
          { value: "no", label: "Norway" },
          { value: "nz", label: "New Zealand" },
          { value: "ph", label: "Philippines" },
          { value: "pl", label: "Poland" },
          { value: "pt", label: "Portugal" },
          { value: "ru", label: "Russia" },
          { value: "se", label: "Sweden" },
          { value: "sg", label: "Singapore" },
          { value: "th", label: "Thailand" },
          { value: "tw", label: "Taiwan" },
          { value: "uk", label: "United Kingdom" },
          { value: "us-old", label: "US (Old)" },
          { value: "us", label: "US" },
          { value: "ve", label: "Venezuela" },
          { value: "za", label: "South Africa" },
        ],
        description:
          "Specifies which country ringtone to play when play_ringtone is set to true. If not set, the US ringtone will be played.",
      },
      mute_dtmf: {
        type: "select",
        label: "Mute DTMF",
        required: false,
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "both", label: "Both" },
          { value: "self", label: "Self" },
          { value: "opposite", label: "Opposite" },
        ],
        description:
          "When enabled, DTMF tones are not passed to the call participant. The webhooks containing the DTMF information will be sent.",
      },
      record: {
        type: "select",
        label: "Record",
        required: false,
        options: [{ value: "record-from-answer", label: "Record From Answer" }],
        description:
          "Start recording automatically after an event. Disabled by default.",
      },
      record_channels: {
        type: "select",
        label: "Record Channels",
        required: false,
        default: "dual",
        options: [
          { value: "single", label: "Single" },
          { value: "dual", label: "Dual" },
        ],
        description:
          "Defines which channel should be recorded ('single' or 'dual') when record is specified.",
      },
      record_format: {
        type: "select",
        label: "Record Format",
        required: false,
        default: "mp3",
        options: [
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
        ],
        description:
          "Defines the format of the recording ('wav' or 'mp3') when record is specified.",
      },
      record_max_length: {
        type: "number",
        label: "Record Max Length (seconds)",
        required: false,
        default: 0,
        min: 0,
        max: 43200,
        description:
          "Defines the maximum length for the recording in seconds when record is specified. The minimum value is 0. The maximum value is 43200. The default value is 0 (infinite).",
      },
      record_timeout_secs: {
        type: "number",
        label: "Record Timeout (seconds)",
        required: false,
        default: 0,
        min: 0,
        description:
          "The number of seconds that Telnyx will wait for the recording to be stopped if silence is detected when record is specified. The timer only starts when the speech is detected. Please note that call transcription is used to detect silence and the related charge will be applied. The minimum value is 0. The default value is 0 (infinite).",
      },
      record_track: {
        type: "select",
        label: "Record Track",
        required: false,
        default: "both",
        options: [
          { value: "inbound", label: "Inbound" },
          { value: "outbound", label: "Outbound" },
          { value: "both", label: "Both" },
        ],
        description:
          "The audio track to be recorded. Can be either 'both', 'inbound' or 'outbound'. If only single track is specified ('inbound', 'outbound'), 'channels' configuration is ignored and it will be recorded as mono (single channel).",
      },
      record_trim: {
        type: "select",
        label: "Record Trim",
        required: false,
        options: [{ value: "trim-silence", label: "Trim Silence" }],
        description:
          "When set to 'trim-silence', silence will be removed from the beginning and end of the recording.",
      },
      record_custom_file_name: {
        type: "string",
        label: "Record Custom File Name",
        required: false,
        maxLength: 40,
        description:
          "The custom recording file name to be used instead of the default call_leg_id. Telnyx will still add a Unix timestamp suffix.",
      },
    },
  },

  set_queue_options: {
    id: "set_queue_options",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Set Queue Options",
    icon: "IconSettings",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description:
      "Set queue name, call priority (1-5 stars), and skills in client state. Call priority and skills work together - high-priority skilled calls route first.",
    telnyxAction: "client_state_update",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/client_state_update",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Options Set"],
    outputEvents: [],
    outputDescriptions: ["Queue options were successfully set"],
    customEditor: "SetQueueOptionsNodeEditor",
    config: {
      queue_name: {
        type: "string",
        label: "Queue Name",
        required: true,
        description: "The name of the queue (can use {{variable}} notation)",
      },
      call_priority: {
        type: "number",
        label: "Call Priority",
        required: false,
        min: 1,
        max: 5,
        default: 3,
        description:
          "Call priority level (1-5 stars: 1=Low, 3=Normal, 5=High). Higher priority calls are routed first. Display as star rating in UI. Can use {{variable}} notation.",
      },
      skills: {
        type: "array",
        label: "Required Skills",
        required: false,
        description:
          "Skills with minimum proficiency levels (1-5 stars). Optional. Can be combined with call priority.",
      },
    },
  },

  enqueue: {
    id: "enqueue",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Enqueue Call",
    icon: "IconList",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description:
      "Put the call in a queue. Supports call priority (1-5 stars) for routing.",
    telnyxAction: "enqueue",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/enqueue",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Enqueued"],
    outputEvents: ["call.enqueued"],
    outputDescriptions: ["Call was successfully enqueued (call.enqueued)"],
    customEditor: "EnqueueNodeEditor",
    config: {
      queue_name: {
        type: "select",
        label: "Queue Name",
        required: true,
        default: "",
        options: [
          { value: "SALES", label: "SALES" },
          { value: "SUPPORT", label: "SUPPORT" },
          { value: "MARKETING", label: "MARKETING" },
        ],
        description:
          "The name of the queue the call should be put in. If a queue with a given name doesn't exist yet it will be created.",
      },
      call_priority: {
        type: "number",
        label: "Call Priority",
        required: false,
        min: 1,
        max: 5,
        default: 3,
        description:
          "Call priority level (1-5 stars: 1=Low, 3=Normal, 5=High). Higher priority calls are routed first. Defaults to queue's default_call_priority if not specified. Display as star rating in UI. Can use {{variable}} notation.",
      },
      max_wait_time_secs: {
        type: "number",
        label: "Max Wait Time (seconds)",
        required: false,
        placeholder: "600",
        description:
          "The number of seconds after which the call will be removed from the queue",
      },
      max_size: {
        type: "number",
        label: "Max Queue Size",
        required: false,
        default: 100,
        placeholder: "200",
        description:
          "The maximum number of calls allowed in the queue at a given time. Note: This parameter is not sent to Telnyx API as max_size cannot be modified for existing queues. Kept in config for backward compatibility only.",
      },
      keep_after_hangup: {
        type: "boolean",
        label: "Keep After Hangup",
        required: false,
        default: false,
        description:
          "If set to true, the call will remain in the queue after hangup. In this case bridging to such call will fail with necessary information needed to re-establish the call.",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
    },
  },

  leave_queue: {
    id: "leave_queue",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Remove Call from Queue",
    icon: "IconListX",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Removes the call from the queue it is currently enqueued in",
    telnyxAction: "leave_queue",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/leave_queue",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Removed"],
    outputEvents: ["call.dequeued"],
    outputDescriptions: [
      "Call was successfully removed from the queue (call.dequeued)",
    ],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same command_id for the same call_control_id.",
      },
    },
  },

  client_state_update: {
    id: "client_state_update",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "Update Client State",
    icon: "IconEdit",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Updates client state for every subsequent webhook",
    telnyxAction: "client_state_update",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/client_state_update",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Updated"],
    outputEvents: [],
    outputDescriptions: ["Client state was successfully updated"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: true,
        placeholder: "aGF2ZSBhIG5pY2UgZGF5ID1d",
        description:
          "Base-64 encoded string to add state to every subsequent webhook. Must be a valid Base-64 encoded string.",
      },
    },
  },

  refer: {
    id: "refer",
    category: NODE_CATEGORIES.CALL_CONTROL,
    label: "SIP Refer",
    icon: "IconPhoneForward",
    color: NODE_COLORS[NODE_CATEGORIES.CALL_CONTROL],
    description: "Initiate a SIP Refer on a Call Control call",
    telnyxAction: "refer",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/refer",
    inputs: 1,
    outputs: 3,
    outputLabels: ["Started", "Completed", "Failed"],
    outputEvents: [
      "call.refer.started",
      "call.refer.completed",
      "call.refer.failed",
    ],
    outputDescriptions: [
      "SIP Refer started (call.refer.started)",
      "SIP Refer completed (call.refer.completed)",
      "SIP Refer failed (call.refer.failed)",
    ],
    customEditor: "ReferNodeEditor",
    config: {
      sip_address: {
        type: "string",
        label: "SIP Address",
        required: true,
        placeholder: "sip:username@sip.non-telnyx-address.com",
        description: "The SIP URI to which the call will be referred to",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description:
          "Base-64 encoded string to add state to every subsequent webhook",
      },
      command_id: {
        type: "string",
        label: "Command ID",
        required: false,
        description:
          "Use this field to avoid execution of duplicate commands. Telnyx will ignore subsequent commands with the same command_id as one that has already been executed.",
      },
      sip_auth_username: {
        type: "string",
        label: "SIP Auth Username",
        required: false,
        description: "SIP Authentication username used for SIP challenges",
      },
      sip_auth_password: {
        type: "string",
        label: "SIP Auth Password",
        required: false,
        description: "SIP Authentication password used for SIP challenges",
      },
    },
  },

  // AUDIO OUTPUT NODES
  speak: {
    id: "speak",
    category: NODE_CATEGORIES.AUDIO_OUTPUT,
    label: "Speak Text",
    icon: "IconVolume",
    color: NODE_COLORS[NODE_CATEGORIES.AUDIO_OUTPUT],
    description: "Convert text to speech and play it on the call",
    telnyxAction: "speak",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/speak",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Started", "Ended"],
    outputEvents: ["call.speak.started", "call.speak.ended"],
    outputDescriptions: [
      "Text-to-speech has started playing (call.speak.started)",
      "Text-to-speech finished playing (call.speak.ended)",
    ],
    customEditor: "SpeakNodeEditor", // Use custom editor component
    config: {
      payload: {
        type: "textarea",
        label: "Text to Speak",
        required: true,
        placeholder: "Hello, welcome to our service",
        description:
          "The text or SSML to be converted into speech (3,000 character limit)",
      },
      voice: {
        type: "voice-picker",
        label: "Voice",
        required: true,
        default: "AWS.Polly.Joanna",
        description:
          "The voice provider, model, and voice to use for speech synthesis",
      },
      voice_api_key_ref: {
        type: "secret-select",
        label: "Voice API Key",
        required: false,
        description:
          "API key reference for ElevenLabs or other voice providers requiring authentication",
      },
    },
  },

  play_audio: {
    id: "play_audio",
    category: NODE_CATEGORIES.AUDIO_OUTPUT,
    label: "Play Audio",
    icon: "IconPlayerPlay",
    color: NODE_COLORS[NODE_CATEGORIES.AUDIO_OUTPUT],
    description: "Play an audio file from a URL",
    telnyxAction: "playback_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/playback_start",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Started", "Ended"],
    outputEvents: ["call.playback.started", "call.playback.ended"],
    outputDescriptions: [
      "Audio playback has started (call.playback.started)",
      "Audio playback has ended (call.playback.ended)",
    ],
    customEditor: "PlayAudioNodeEditor", // Use custom editor component
    config: {
      audio_url: {
        type: "string",
        label: "Audio URL",
        required: true,
        placeholder: "https://example.com/audio.mp3",
        description: "The URL of the audio file to play (WAV or MP3)",
      },
      loop: {
        type: "select",
        label: "Loop",
        required: false,
        default: "1",
        options: [
          { value: "1", label: "1 time" },
          { value: "2", label: "2 times" },
          { value: "3", label: "3 times" },
          { value: "4", label: "4 times" },
          { value: "5", label: "5 times" },
          { value: "6", label: "6 times" },
          { value: "7", label: "7 times" },
          { value: "8", label: "8 times" },
          { value: "9", label: "9 times" },
          { value: "10", label: "10 times" },
          { value: "infinity", label: "Loop infinitely" },
        ],
        description:
          "How many times the audio file should be played (1-10 or infinity)",
      },
      overlay: {
        type: "boolean",
        label: "Overlay",
        required: false,
        default: false,
        description: "Play audio over any currently playing audio",
      },
      target_legs: {
        type: "select",
        label: "Target Legs",
        required: false,
        default: "self",
        options: [
          { value: "self", label: "Self" },
          { value: "opposite", label: "Opposite" },
          { value: "both", label: "Both" },
        ],
        description: "Specifies which leg(s) of the call will hear the audio",
      },
    },
  },

  // INPUT COLLECTION NODES
  gather: {
    id: "gather",
    category: NODE_CATEGORIES.INPUT_COLLECTION,
    label: "Gather",
    icon: "IconKeyboard",
    color: NODE_COLORS[NODE_CATEGORIES.INPUT_COLLECTION],
    description: "Collect DTMF digits from the caller",
    telnyxAction: "gather",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/gather",
    inputs: 1,
    outputs: 2,
    outputLabels: ["DTMF Received", "Gather Ended"],
    outputEvents: ["call.dtmf.received", "call.gather.ended"],
    outputDescriptions: [
      "DTMF digit received (may receive multiple)",
      "Gather ended - all digits collected",
    ],
    config: {
      minimum_digits: {
        type: "number",
        label: "Minimum Digits",
        required: false,
        default: 1,
        min: 1,
        description: "The minimum number of digits to fetch",
      },
      maximum_digits: {
        type: "number",
        label: "Maximum Digits",
        required: false,
        default: 128,
        max: 128,
        description: "The maximum number of digits to fetch",
      },
      timeout_millis: {
        type: "number",
        label: "Timeout (ms)",
        required: false,
        default: 60000,
        description:
          "The number of milliseconds to wait to complete the request",
      },
      inter_digit_timeout_millis: {
        type: "number",
        label: "Inter-digit Timeout (ms)",
        required: false,
        default: 5000,
        description:
          "The number of milliseconds to wait for input between digits",
      },
      initial_timeout_millis: {
        type: "number",
        label: "Initial Timeout (ms)",
        required: false,
        default: 5000,
        description: "The number of milliseconds to wait for the first DTMF",
      },
      terminating_digit: {
        type: "string",
        label: "Terminating Digit",
        required: false,
        default: "#",
        placeholder: "#",
        description: "Digit used to terminate input",
      },
      valid_digits: {
        type: "string",
        label: "Valid Digits",
        required: false,
        default: "0123456789#*",
        description: "A list of all digits accepted as valid",
      },
    },
  },

  gather_speak: {
    id: "gather_speak",
    category: NODE_CATEGORIES.INPUT_COLLECTION,
    label: "Gather Using Speak",
    icon: "IconMicrophone",
    color: NODE_COLORS[NODE_CATEGORIES.INPUT_COLLECTION],
    description: "Play text-to-speech and collect DTMF digits",
    telnyxAction: "gather_using_speak",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/gather_using_speak",
    inputs: 1,
    outputs: 2,
    outputLabels: ["DTMF Received", "Gather Ended"],
    outputEvents: ["call.dtmf.received", "call.gather.ended"],
    outputDescriptions: [
      "DTMF digit received (may receive multiple)",
      "Gather ended - all digits collected",
    ],
    customEditor: "GatherSpeakNodeEditor", // Use custom editor component
    config: {
      payload: {
        type: "textarea",
        label: "Text to Speak",
        required: true,
        placeholder: "Press 1 for sales, 2 for support",
        description:
          "The text or SSML to be converted into speech (3,000 character limit)",
      },
      voice: {
        type: "voice-picker",
        label: "Voice",
        required: true,
        default: "AWS.Polly.Joanna",
        description:
          "The voice provider, model, and voice to use for speech synthesis",
      },
      voice_api_key_ref: {
        type: "secret-select",
        label: "Voice API Key",
        required: false,
        description:
          "API key reference for ElevenLabs or other voice providers requiring authentication",
      },
      minimum_digits: {
        type: "number",
        label: "Minimum Digits",
        required: false,
        default: 1,
        min: 1,
        description: "The minimum number of digits to fetch",
      },
      maximum_digits: {
        type: "number",
        label: "Maximum Digits",
        required: false,
        default: 128,
        max: 128,
        description: "The maximum number of digits to fetch",
      },
      timeout_millis: {
        type: "number",
        label: "Timeout (ms)",
        required: false,
        default: 60000,
        description: "Milliseconds to wait for DTMF response after speech ends",
      },
      inter_digit_timeout_millis: {
        type: "number",
        label: "Inter-digit Timeout (ms)",
        required: false,
        default: 5000,
        description:
          "The number of milliseconds to wait for input between digits",
      },
      terminating_digit: {
        type: "string",
        label: "Terminating Digit",
        required: false,
        default: "#",
        placeholder: "#",
        description: "Digit used to terminate input",
      },
      valid_digits: {
        type: "string",
        label: "Valid Digits",
        required: false,
        default: "0123456789#*",
        description: "A list of all digits accepted as valid",
      },
    },
  },

  // AI INTEGRATION NODES
  ai_assistant_start: {
    id: "ai_assistant_start",
    category: NODE_CATEGORIES.AI_INTEGRATION,
    label: "Start AI Assistant",
    icon: "IconRobot",
    color: NODE_COLORS[NODE_CATEGORIES.AI_INTEGRATION],
    description: "Start an AI assistant on the call",
    telnyxAction: "ai_assistant_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/ai_assistant_start",
    inputs: 1,
    outputs: 3,
    outputLabels: ["Started", "Ended", "Insights Generated"],
    outputEvents: [
      "call.conversation.created",
      "call.conversation.ended",
      "call.conversation_insights.generated",
    ],
    outputDescriptions: [
      "Triggered when AI conversation starts (call.conversation.created)",
      "Triggered when AI conversation ends (call.conversation.ended)",
      "Triggered when conversation insights are generated (call.conversation_insights.generated)",
    ],
    config: {
      assistant_id: {
        type: "ai_assistant_select",
        label: "AI Assistant",
        required: true,
        placeholder: "Select AI Assistant...",
      },
    },
  },

  ai_assistant_stop: {
    id: "ai_assistant_stop",
    category: NODE_CATEGORIES.AI_INTEGRATION,
    label: "Stop AI Assistant",
    icon: "IconRobotOff",
    color: NODE_COLORS[NODE_CATEGORIES.AI_INTEGRATION],
    description: "Stop the AI assistant on the call",
    telnyxAction: "ai_assistant_stop",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/ai_assistant_stop",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Stopped"],
    outputEvents: ["call.conversation.ended"],
    config: {},
  },

  // RECORDING NODES
  record_start: {
    id: "record_start",
    category: NODE_CATEGORIES.RECORDING,
    label: "Start Recording",
    icon: "IconCircleFilled",
    color: NODE_COLORS[NODE_CATEGORIES.RECORDING],
    description: "Start recording the call",
    telnyxAction: "record_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/record_start",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Started", "Saved"],
    outputEvents: ["call.recording.started", "call.recording.saved"],
    outputDescriptions: [
      "Recording started successfully (immediate response)",
      "Recording completed and saved (webhook event)",
    ],
    config: {
      format: {
        type: "select",
        label: "Format",
        required: true,
        default: "mp3",
        options: [
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
        ],
        description: "The audio file format for the recording",
      },
      channels: {
        type: "select",
        label: "Channels",
        required: true,
        default: "single",
        options: [
          { value: "single", label: "Single (Mono)" },
          { value: "dual", label: "Dual (Stereo)" },
        ],
        description: "Recording channel configuration",
      },
      play_beep: {
        type: "boolean",
        label: "Play Beep",
        required: false,
        default: false,
        description: "Play a beep sound at the start of recording",
      },
    },
  },

  record_stop: {
    id: "record_stop",
    category: NODE_CATEGORIES.RECORDING,
    label: "Stop Recording",
    icon: "IconSquare",
    color: NODE_COLORS[NODE_CATEGORIES.RECORDING],
    description: "Stop the call recording",
    telnyxAction: "record_stop",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/record_stop",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Stopped"],
    outputEvents: ["call.recording.saved"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description: "Base-64 encoded string to add state to webhooks",
      },
    },
  },

  record_pause: {
    id: "record_pause",
    category: NODE_CATEGORIES.RECORDING,
    label: "Pause Recording",
    icon: "IconPlayerPause",
    color: NODE_COLORS[NODE_CATEGORIES.RECORDING],
    description: "Pause the call recording",
    telnyxAction: "record_pause",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/record_pause",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Paused"],
    outputEvents: ["call.recording.paused"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description: "Base-64 encoded string to add state to webhooks",
      },
    },
  },

  record_resume: {
    id: "record_resume",
    category: NODE_CATEGORIES.RECORDING,
    label: "Resume Recording",
    icon: "IconPlayerPlay",
    color: NODE_COLORS[NODE_CATEGORIES.RECORDING],
    description: "Resume the call recording",
    telnyxAction: "record_resume",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/record_resume",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Resumed"],
    outputEvents: ["call.recording.resumed"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description: "Base-64 encoded string to add state to webhooks",
      },
    },
  },

  // TRANSCRIPTION NODES
  transcription_start: {
    id: "transcription_start",
    category: NODE_CATEGORIES.TRANSCRIPTION,
    label: "Start Transcription",
    icon: "IconFileText",
    color: NODE_COLORS[NODE_CATEGORIES.TRANSCRIPTION],
    description: "Start live transcription of the call",
    telnyxAction: "transcription_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/transcription_start",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Transcribing"],
    outputEvents: ["call.transcription"],
    customEditor: "TranscriptionNodeEditor",
    config: {
      transcription_engine: {
        type: "select",
        label: "Provider",
        required: true,
        default: "Google",
        options: [
          { value: "Google", label: "Google" },
          { value: "Telnyx", label: "Telnyx" },
          { value: "Deepgram", label: "Deepgram" },
          { value: "Azure", label: "Azure" },
        ],
        description: "The transcription service provider",
      },
      language: {
        type: "string",
        label: "Language",
        required: false,
        default: "en",
        placeholder: "en",
        description: "Language for speech recognition",
      },
    },
  },

  transcription_stop: {
    id: "transcription_stop",
    category: NODE_CATEGORIES.TRANSCRIPTION,
    label: "Stop Transcription",
    icon: "IconFileOff",
    color: NODE_COLORS[NODE_CATEGORIES.TRANSCRIPTION],
    description: "Stop live transcription",
    telnyxAction: "transcription_stop",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/transcription_stop",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Stopped"],
    outputEvents: ["call.transcription.saved"],
    config: {
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description: "Base-64 encoded string to add state to webhooks",
      },
    },
  },

  streaming_start: {
    id: "streaming_start",
    category: NODE_CATEGORIES.STREAMING,
    label: "Start Streaming",
    icon: "IconBroadcast",
    color: NODE_COLORS[NODE_CATEGORIES.STREAMING],
    description: "Start streaming media to a WebSocket address",
    telnyxAction: "streaming_start",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/streaming_start",
    inputs: 1,
    outputs: 2,
    outputLabels: ["Started", "Failed"],
    outputEvents: ["streaming.started", "streaming.failed"],
    outputDescriptions: [
      "Streaming started successfully (streaming.started)",
      "Streaming failed to start (streaming.failed)",
    ],
    customEditor: "StreamingStartNodeEditor",
    config: {
      ai_streaming_provider: {
        type: "select",
        label: "AI Provider",
        required: false,
        default: "custom",
        options: [
          { value: "custom", label: "Custom" },
          { value: "google-gemini", label: "Google Gemini Live" },
          { value: "openai-realtime", label: "OpenAI Realtime" },
        ],
        description:
          "Select an AI provider for automatic configuration, or choose Custom for manual settings",
      },
      stream_url: {
        type: "string",
        label: "Stream URL",
        required: true,
        placeholder: "wss://www.example.com/websocket",
        description: "The destination WebSocket address",
      },
      stream_track: {
        type: "select",
        label: "Stream Track",
        required: false,
        default: "inbound_track",
        options: [
          { value: "inbound_track", label: "Inbound Track" },
          { value: "outbound_track", label: "Outbound Track" },
          { value: "both_tracks", label: "Both Tracks" },
        ],
        description: "Specifies which track should be streamed",
      },
      stream_codec: {
        type: "select",
        label: "Stream Codec",
        required: false,
        default: "default",
        options: [
          { value: "PCMU", label: "PCMU" },
          { value: "PCMA", label: "PCMA" },
          { value: "G722", label: "G722" },
          { value: "OPUS", label: "OPUS" },
          { value: "AMR-WB", label: "AMR-WB" },
          { value: "L16", label: "L16" },
          { value: "default", label: "Default (from call)" },
        ],
        description: "Codec to be used for the streamed audio.",
      },
      stream_bidirectional_mode: {
        type: "select",
        label: "Bidirectional Stream Mode",
        required: false,
        default: "mp3",
        options: [
          { value: "mp3", label: "MP3" },
          { value: "rtp", label: "RTP" },
        ],
        description: "Method of bidirectional streaming (mp3, rtp)",
      },
      stream_bidirectional_codec: {
        type: "select",
        label: "Bidirectional Stream Codec",
        required: false,
        default: "PCMU",
        options: [
          { value: "PCMU", label: "PCMU" },
          { value: "PCMA", label: "PCMA" },
          { value: "G722", label: "G722" },
          { value: "OPUS", label: "OPUS" },
          { value: "AMR-WB", label: "AMR-WB" },
          { value: "L16", label: "L16" },
        ],
        description: "Codec for bidirectional RTP streaming RTP.",
      },
      stream_bidirectional_target_legs: {
        type: "select",
        label: "Bidirectional Stream Target Legs",
        required: false,
        default: "opposite",
        options: [
          { value: "both", label: "Both" },
          { value: "self", label: "Self" },
          { value: "opposite", label: "Opposite" },
        ],
        description: "Call legs to receive the bidirectional stream audio.",
      },
      stream_bidirectional_sampling_rate: {
        type: "select",
        label: "Bidirectional Stream Sampling Rate",
        required: false,
        default: 8000,
        options: [
          { value: 8000, label: "8000 Hz" },
          { value: 16000, label: "16000 Hz" },
          { value: 22050, label: "22050 Hz" },
          { value: 24000, label: "24000 Hz" },
          { value: 48000, label: "48000 Hz" },
        ],
        description: "Audio sampling rate",
      },
    },
  },

  streaming_stop: {
    id: "streaming_stop",
    category: NODE_CATEGORIES.STREAMING,
    label: "Stop Streaming",
    icon: "IconBroadcastOff",
    color: NODE_COLORS[NODE_CATEGORIES.STREAMING],
    description: "Stop streaming media to WebSocket",
    telnyxAction: "streaming_stop",
    telnyxEndpoint: "/v2/calls/:call_control_id/actions/streaming_stop",
    inputs: 1,
    outputs: 1,
    outputLabels: ["Stopped"],
    outputEvents: ["streaming.stopped"],
    outputDescriptions: ["Streaming stopped successfully (streaming.stopped)"],
    config: {
      stream_id: {
        type: "string",
        label: "Stream ID",
        required: false,
        placeholder: "1edb94f9-7ef0-4150-b502-e0ebadfd9491",
        description:
          "Identifies the stream. If not provided, stops all streams associated with the call",
      },
      client_state: {
        type: "string",
        label: "Client State",
        required: false,
        description: "Base-64 encoded string to add state to webhooks",
      },
    },
  },

  // LOGICAL NODES
  condition: {
    id: "condition",
    category: NODE_CATEGORIES.LOGICAL,
    label: "Condition",
    icon: "IconGitBranch",
    color: NODE_COLORS[NODE_CATEGORIES.LOGICAL],
    description: "Evaluate a condition and route based on true/false result",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 2,
    outputLabels: ["True", "False"],
    outputEvents: [],
    customEditor: "ConditionNodeEditor",
    config: {
      leftOperand: {
        type: "string",
        label: "Left Operand",
        required: true,
        placeholder: "{{variable}} or value",
        description: "Left side of the comparison",
      },
      operator: {
        type: "select",
        label: "Operator",
        required: true,
        default: "===",
        options: [
          { value: "===", label: "Equals (===)" },
          { value: "!==", label: "Not Equals (!==)" },
          { value: ">", label: "Greater Than (>)" },
          { value: "<", label: "Less Than (<)" },
          { value: ">=", label: "Greater or Equal (>=)" },
          { value: "<=", label: "Less or Equal (<=)" },
          { value: "contains", label: "Contains" },
          { value: "startsWith", label: "Starts With" },
          { value: "endsWith", label: "Ends With" },
        ],
        description: "Comparison operator",
      },
      rightOperand: {
        type: "string",
        label: "Right Operand",
        required: true,
        placeholder: "{{variable}} or value",
        description: "Right side of the comparison",
      },
      dataType: {
        type: "select",
        label: "Data Type",
        required: false,
        default: "string",
        options: [
          { value: "string", label: "String" },
          { value: "number", label: "Number" },
          { value: "boolean", label: "Boolean" },
        ],
        description: "Type for comparison",
      },
    },
  },

  switch: {
    id: "switch",
    category: NODE_CATEGORIES.LOGICAL,
    label: "Switch",
    icon: "IconGitMerge",
    color: NODE_COLORS[NODE_CATEGORIES.LOGICAL],
    description: "Route to different paths based on variable value",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 1, // Dynamic - updated by editor
    outputLabels: ["Default"],
    outputEvents: [],
    customEditor: "SwitchNodeEditor",
    config: {
      variable: {
        type: "string",
        label: "Variable to Evaluate",
        required: true,
        placeholder: "{{variable}}",
        description: "Variable whose value determines the route",
      },
      cases: {
        type: "array",
        label: "Cases",
        required: false,
        default: [],
        description: "Array of {value, label} objects for each case",
      },
      defaultLabel: {
        type: "string",
        label: "Default Label",
        required: false,
        default: "Default",
        description: "Label for the default output",
      },
    },
  },

  set_variable: {
    id: "set_variable",
    category: NODE_CATEGORIES.LOGICAL,
    label: "Set Variable",
    icon: "IconVariable",
    color: NODE_COLORS[NODE_CATEGORIES.LOGICAL],
    description: "Create or update a variable using an expression",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 1,
    outputLabels: ["Continue"],
    outputEvents: [],
    customEditor: "SetVariableNodeEditor",
    config: {
      variableName: {
        type: "string",
        label: "Variable Name",
        required: true,
        placeholder: "my_variable",
        description: "Name of the variable to set",
      },
      expression: {
        type: "textarea",
        label: "Expression",
        required: true,
        placeholder: "{{first_name}} + ' ' + {{last_name}}",
        description: "Expression to evaluate and store in the variable",
      },
    },
  },

  logic_gate: {
    id: "logic_gate",
    category: NODE_CATEGORIES.LOGICAL,
    label: "Logic Gate",
    icon: "IconCircuitSwitchOpen",
    color: NODE_COLORS[NODE_CATEGORIES.LOGICAL],
    description: "Combine multiple conditions with AND/OR/NOT logic",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 2,
    outputLabels: ["True", "False"],
    outputEvents: [],
    customEditor: "LogicGateNodeEditor",
    config: {
      operator: {
        type: "select",
        label: "Operator",
        required: true,
        default: "AND",
        options: [
          { value: "AND", label: "AND (all true)" },
          { value: "OR", label: "OR (at least one true)" },
          { value: "NOT", label: "NOT (invert)" },
        ],
        description: "Logical operator to combine conditions",
      },
      conditions: {
        type: "array",
        label: "Conditions",
        required: false,
        default: [],
        description: "Array of condition objects",
      },
    },
  },

  flow_end: {
    id: "flow_end",
    category: NODE_CATEGORIES.LOGICAL,
    label: "Flow End",
    icon: "IconFlag",
    color: NODE_COLORS[NODE_CATEGORIES.LOGICAL],
    description: "Marks the end of a flow path - no action taken",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 0,
    outputLabels: [],
    outputEvents: [],
    config: {},
  },

  // INTEGRATION NODES
  http_request_action: {
    id: "http_request_action",
    category: NODE_CATEGORIES.INTEGRATION,
    label: "HTTP Request",
    icon: "IconApi",
    color: NODE_COLORS[NODE_CATEGORIES.INTEGRATION],
    description: "Make an HTTP request to an external API",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 2,
    outputLabels: ["Success", "Error"],
    outputEvents: ["http.success", "http.error"],
    customEditor: "HttpRequestNodeEditor",
    config: {
      url: {
        type: "string",
        label: "URL",
        required: true,
        placeholder: "https://api.example.com/endpoint",
        description: "API endpoint URL (supports variable substitution)",
      },
      method: {
        type: "select",
        label: "Method",
        required: true,
        default: "GET",
        options: [
          { value: "GET", label: "GET" },
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" },
        ],
        description: "HTTP method",
      },
      headers: {
        type: "key-value",
        label: "Headers",
        required: false,
        description: "HTTP headers (key-value pairs)",
      },
      pathParams: {
        type: "key-value",
        label: "Path Parameters",
        required: false,
        description: "URL path parameters (key-value pairs)",
      },
      queryParams: {
        type: "key-value",
        label: "Query Parameters",
        required: false,
        description: "URL query parameters (key-value pairs)",
      },
      bodyParams: {
        type: "key-value",
        label: "Body Parameters",
        required: false,
        description: "Request body parameters (key-value pairs)",
      },
      bodyType: {
        type: "select",
        label: "Body Type",
        required: false,
        default: "json",
        options: [
          { value: "json", label: "JSON" },
          { value: "params", label: "Parameters" },
        ],
        description: "Request body format",
      },
      body: {
        type: "textarea",
        label: "Request Body",
        required: false,
        placeholder: '{"key": "value"}',
        description: "Request body for POST/PUT (supports variables)",
      },
      timeout: {
        type: "number",
        label: "Timeout (ms)",
        required: false,
        default: 30000,
        description: "Request timeout in milliseconds",
      },
      responseVariable: {
        type: "string",
        label: "Response Variable Name",
        required: false,
        default: "http_response",
        placeholder: "http_response",
        description: "Variable name to store the response",
      },
    },
  },

  data_action: {
    id: "data_action",
    category: NODE_CATEGORIES.INTEGRATION,
    label: "Data Action",
    icon: "IconDatabase",
    color: NODE_COLORS[NODE_CATEGORIES.INTEGRATION],
    description: "Perform CRUD operations on Contacts, KB Articles, or Tasks",
    telnyxAction: null,
    telnyxEndpoint: null,
    inputs: 1,
    outputs: 2,
    outputLabels: ["Success", "Error"],
    outputEvents: ["data.success", "data.error"],
    customEditor: "DataActionsNodeEditor",
    config: {
      dataSource: {
        type: "select",
        label: "Data Source",
        required: true,
        options: [
          { value: "contacts", label: "Contacts" },
          { value: "kb_articles", label: "KB Articles" },
          { value: "tasks", label: "Tasks" },
        ],
        description: "Select the data source to operate on",
      },
      action: {
        type: "select",
        label: "Action",
        required: true,
        options: [
          { value: "create", label: "Create" },
          { value: "read", label: "Read (Get Single)" },
          { value: "update", label: "Update" },
          { value: "delete", label: "Delete" },
          { value: "list", label: "List/Search" },
        ],
        description: "Select the operation to perform",
      },
      fields: {
        type: "object",
        label: "Fields",
        required: false,
        description: "Field values (dynamically generated)",
      },
      recordId: {
        type: "string",
        label: "Record ID",
        required: false,
        description: "ID of the record (supports {{variable}})",
      },
      queryParams: {
        type: "object",
        label: "Query Parameters",
        required: false,
        description: "Search/filter parameters",
      },
      responseVariable: {
        type: "string",
        label: "Response Variable Name",
        required: false,
        default: "data_response",
        description: "Variable name to store the API response",
      },
    },
  },
};

/**
 * Get all nodes grouped by category
 */
export function getNodesByCategory() {
  const grouped = {};
  Object.values(VOICE_FLOW_NODES).forEach((node) => {
    if (!grouped[node.category]) {
      grouped[node.category] = [];
    }
    grouped[node.category].push(node);
  });
  return grouped;
}

/**
 * Get node definition by ID
 */
export function getNodeById(nodeId) {
  return VOICE_FLOW_NODES[nodeId] || null;
}

/**
 * Get category display name
 */
export function getCategoryDisplayName(category) {
  const names = {
    [NODE_CATEGORIES.INITIATOR]: "Initiators",
    [NODE_CATEGORIES.CALL_CONTROL]: "Call Control",
    [NODE_CATEGORIES.AUDIO_OUTPUT]: "Audio Output",
    [NODE_CATEGORIES.INPUT_COLLECTION]: "Input Collection",
    [NODE_CATEGORIES.AI_INTEGRATION]: "AI Integration",
    [NODE_CATEGORIES.RECORDING]: "Recording",
    [NODE_CATEGORIES.TRANSCRIPTION]: "Transcription",
    [NODE_CATEGORIES.STREAMING]: "Streaming",
    [NODE_CATEGORIES.LOGICAL]: "Logical Operations",
    [NODE_CATEGORIES.INTEGRATION]: "Integrations",
  };
  return names[category] || category;
}
