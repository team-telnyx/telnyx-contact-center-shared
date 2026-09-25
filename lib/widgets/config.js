import {
  AVATAR_MODAL_WIDTH_OPTIONS,
  DEFAULT_AVATAR_MODAL_WIDTH_PERCENT,
  publicAIMediaSettings,
} from "../ai/avatar-config.mjs";
import { z } from "zod";
import { WIDGET_ICON_IDS, normalizeWidgetIconId } from "./icon-catalog.js";
import { localizeWidgetConfig } from "./locales.js";
import { DOCUMENT_PREVIEW_SIZE } from "../documents/preview-types.mjs";

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit hex color");
const optionalHttpsUrl = z
  .string()
  .trim()
  .refine(
    (value) => !value || /^https:\/\//i.test(value),
    "Only HTTPS URLs are allowed"
  );

const previewImageSource = z
  .string()
  .trim()
  .max(8_000_000, "Preview screenshot is too large")
  .refine(
    (value) => !value || /^https:\/\//i.test(value) || /^data:image\/(?:png|jpeg|webp);base64,/i.test(value) || /^\/api\/admin\/widgets\/[0-9a-f-]{36}\/preview-background\?variant=[a-z0-9][a-z0-9_-]{0,80}(?:&v=\d+)?$/i.test(value),
    "Use an HTTPS image URL or upload a PNG, JPEG, or WebP screenshot"
  );

export function isValidWidgetAllowedOrigin(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 300) return false;
  if (/^https:\/\/\*\.[^/:]+(?::\d+)?$/i.test(normalized)) return true;
  if (normalized.includes("*")) return false;
  try {
    const url = new URL(normalized);
    return ["http:", "https:"].includes(url.protocol)
      && url.origin === normalized.toLowerCase().replace(/\/$/, "").toLowerCase();
  } catch {
    return false;
  }
}

const allowedOrigin = z.string().trim().min(1).max(300).refine(
  isValidWidgetAllowedOrigin,
  "Expected an exact HTTP(S) origin or an https://*.example.com wildcard"
);

const avatarSchema = z.object({
  type: z.enum(["icon", "initials", "image"]),
  value: z.string().trim().max(500),
});

const humanAvatarSchema = avatarSchema.extend({
  useAgentProfilePicture: z.boolean().default(false),
});

const widgetIcon = z.enum(WIDGET_ICON_IDS);
const mimeType = z
  .string()
  .trim()
  .regex(/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i, "Expected a MIME type");

const fontFamily = z.enum([
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Source Sans 3",
  "system-ui",
]);

const themeSchema = z.object({
  colors: z.object({
    primary: hexColor,
    onPrimary: hexColor,
    surface: hexColor,
    surfaceMuted: hexColor,
    text: hexColor,
    mutedText: hexColor,
    border: hexColor,
    headerBackground: hexColor,
    headerText: hexColor,
    footerBackground: hexColor,
    footerText: hexColor,
    assistantBubble: hexColor,
    assistantText: hexColor,
    humanBubble: hexColor,
    humanText: hexColor,
    customerBubble: hexColor,
    customerText: hexColor,
    inputBackground: hexColor,
    inputText: hexColor,
  }),
  typography: z.object({
    fontFamily,
    baseSize: z.number().int().min(12).max(20),
    titleSize: z.number().int().min(14).max(30),
    descriptionSize: z.number().int().min(10).max(20),
    messageSize: z.number().int().min(11).max(22),
    participantSize: z.number().int().min(9).max(16),
    metaSize: z.number().int().min(8).max(14),
  }),
  shape: z.object({
    panelRadius: z.number().int().min(0).max(40),
    bubbleRadius: z.number().int().min(0).max(32),
    inputRadius: z.number().int().min(0).max(32),
    buttonRadius: z.number().int().min(0).max(32),
  }),
});

const dimensionsSchema = z.object({
  panelPosition: z.enum(["bottom-right", "bottom-left"]),
  panelOffsetX: z.number().int().min(0).max(160),
  panelOffsetY: z.number().int().min(0).max(160),
  launcherPosition: z.enum(["bottom-right", "bottom-left"]),
  launcherOffsetX: z.number().int().min(0).max(160),
  launcherOffsetY: z.number().int().min(0).max(160),
  panelWidth: z.number().int().min(320).max(720),
  panelHeight: z.number().int().min(420).max(900),
  headerHeight: z.number().int().min(52).max(180),
  footerHeight: z.number().int().min(56).max(160),
  fabSize: z.number().int().min(44).max(96),
  headerPaddingX: z.number().int().min(8).max(48),
  footerPaddingX: z.number().int().min(8).max(48),
  messageMaxWidth: z.number().int().min(50).max(92),
});

const componentsSchema = z.object({
  header: z.object({
    showIcon: z.boolean(),
    showDescription: z.boolean(),
    showClose: z.boolean(),
    iconSize: z.number().int().min(24).max(72),
    alignment: z.enum(["left", "center"]),
    icon: widgetIcon.default("bot"),
    closeIcon: widgetIcon.default("x"),
  }),
  messages: z.object({
    showAvatars: z.boolean(),
    showParticipantNames: z.boolean(),
    showTimestamps: z.boolean(),
    showDeliveryStatus: z.boolean(),
    avatarSize: z.number().int().min(20).max(56),
    spacing: z.number().int().min(4).max(32),
    assistantLabel: z.string().trim().min(1).max(60),
    humanLabel: z.string().trim().min(1).max(60),
    customerLabel: z.string().trim().min(1).max(60),
    typingIndicator: z.object({
      rotatingMessages: z.boolean(),
      alignment: z.enum(["left", "center", "right", "full"]).default("left"),
      spinnerIcon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
      fontSize: z.number().int().min(9).max(20),
    }),
    agentTypingIndicator: z.object({
      enabled: z.boolean(),
      sendCustomerTyping: z.boolean(),
      alignment: z.enum(["left", "center", "right", "full"]).default("left"),
      spinnerIcon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
      fontSize: z.number().int().min(9).max(20),
    }),
  }),
  launcher: z.object({
    style: z.enum(["icon", "icon-label"]),
    icon: widgetIcon,
    label: z.string().trim().min(1).max(80),
    shape: z.enum(["round", "rounded", "square"]),
    backgroundColor: hexColor,
    textColor: hexColor,
    showUnreadBadge: z.boolean(),
    animation: z.enum(["none", "pulse", "bounce", "fade"]),
  }),
  voice: z.object({
    statusBadge: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      // The conversation badge names what the agent is doing, so each state
      // carries its own icon.
      listeningIcon: widgetIcon.default("mic"),
      speakingIcon: widgetIcon.default("volume-2"),
      thinkingIcon: widgetIcon.default("brain"),
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
      fontSize: z.number().int().min(9).max(18),
      iconSize: z.number().int().min(10).max(28),
      radius: z.number().int().min(0).max(999),
    }),
    controls: z.object({
      buttonSize: z.number().int().min(36).max(84),
      callButtonSize: z.number().int().min(44).max(96),
      iconSize: z.number().int().min(14).max(40),
      gap: z.number().int().min(4).max(40),
      radius: z.number().int().min(0).max(999),
      verticalPadding: z.number().int().min(4).max(32),
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
      activeBackgroundColor: hexColor,
      activeTextColor: hexColor,
      callBackgroundColor: hexColor,
      callTextColor: hexColor,
      endBackgroundColor: hexColor,
      endTextColor: hexColor,
      muteIcon: widgetIcon,
      unmuteIcon: widgetIcon,
      callIcon: widgetIcon,
      endCallIcon: widgetIcon,
      speakerIcon: widgetIcon,
      speakerMutedIcon: widgetIcon,
    }),
    waveform: z.object({
      enabled: z.boolean(),
      style: z.enum(["bars", "mirrored", "line", "radial", "ribbon", "dots", "rings"]),
      primaryColor: hexColor,
      secondaryColor: hexColor,
      backgroundColor: hexColor,
      bars: z.number().int().min(8).max(96),
      smoothing: z.number().min(0).max(0.99),
      amplitude: z.number().min(0.25).max(2),
      glow: z.boolean(),
      height: z.number().int().min(56).max(220),
      radius: z.number().int().min(0).max(32).default(16),
      padding: z.number().int().min(0).max(40).default(12),
    }),
    // Appearance of the real-time avatar embedded in the voice panel
    // (Widget Studio → Avatars). The avatar itself is chosen in channels.voice.avatar.
    avatar: z.object({
      maxHeight: z.number().int().min(120).max(800).default(260),
      radius: z.number().int().min(0).max(32).default(16),
      padding: z.number().int().min(0).max(40).default(12),
      backgroundColor: hexColor.default("#f4f7f6"),
      // "cover" crops the video to the box, "contain" letterboxes it.
      fit: z.enum(["cover", "contain"]).default("cover"),
      // Vertical crop focus in percent (0 = top, 100 = bottom); faces sit high.
      focusY: z.number().int().min(0).max(100).default(25),
      showExpandButton: z.boolean().default(true),
      // "top" places the avatar above the call controls, "middle" below them.
      position: z.enum(["top", "middle"]).default("middle"),
      // Latest transcript line overlaid on the embedded avatar (the expanded
      // view has its own transcription toggle).
      showSubtitles: z.boolean().default(false),
      subtitleFontSize: z.number().int().min(10).max(24).default(12),
      subtitlePosition: z.enum(["top", "bottom"]).default("bottom"),
    }).default({ maxHeight: 260, radius: 16, padding: 12, backgroundColor: "#f4f7f6", fit: "cover", focusY: 25, showExpandButton: true, position: "middle", showSubtitles: false, subtitleFontSize: 12, subtitlePosition: "bottom" }),
  }),
  footer: z.object({
    buttonSize: z.number().int().min(32).max(64),
    iconSize: z.number().int().min(14).max(32),
    utilityButtonGap: z.number().int().min(0).max(32),
    utilityInputGap: z.number().int().min(0).max(40),
    inputSendGap: z.number().int().min(0).max(40),
    attachmentIcon: widgetIcon,
    emojiIcon: widgetIcon,
    sendIcon: widgetIcon,
    buttonBackgroundColor: hexColor,
    buttonTextColor: hexColor,
  }),
  handoff: z.object({
    style: z.enum(["divider", "card", "compact"]),
    spacing: z.number().int().min(4).max(32),
    iconSize: z.number().int().min(12).max(32),
    fontSize: z.number().int().min(9).max(18),
    radius: z.number().int().min(0).max(999),
    queue: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
    }),
    assigned: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
    }),
    connected: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
    }),
    disconnected: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
    }).default({
      enabled: true,
      icon: "phone-off",
      backgroundColor: "#f5f5f4",
      textColor: "#44403c",
      borderColor: "#d6d3d1",
    }),
    failed: z.object({
      enabled: z.boolean(),
      icon: widgetIcon,
      backgroundColor: hexColor,
      textColor: hexColor,
      borderColor: hexColor,
    }),
  }),
  attachments: z.object({
    documentIcon: widgetIcon,
    imageIcon: widgetIcon,
    backgroundColor: hexColor,
    textColor: hexColor,
    borderColor: hexColor,
    radius: z.number().int().min(0).max(32),
    iconSize: z.number().int().min(14).max(36),
    preview: z.object({
      // "panel" keeps the viewer inside the widget; "page" expands the embedded
      // frame over the host page so large documents are readable.
      placement: z.enum(["panel", "page"]).default("page"),
      pageWidthPercent: z.number().int().min(30).max(100).default(DOCUMENT_PREVIEW_SIZE.widthPercent),
      pageHeightPercent: z.number().int().min(30).max(100).default(DOCUMENT_PREVIEW_SIZE.heightPercent),
    }).default({ placement: "page", pageWidthPercent: DOCUMENT_PREVIEW_SIZE.widthPercent, pageHeightPercent: DOCUMENT_PREVIEW_SIZE.heightPercent }),
  }),
});

const ANIMATION_DEFAULTS = Object.freeze({
  launcherEntrance: "fade",
  panelEntrance: "scale",
  durationMs: 240,
});

const animationSchema = z.object({
  // How the launcher first appears once its trigger fires.
  launcherEntrance: z.enum(["none", "fade", "scale", "slide-up", "drop"]).default("fade"),
  // How the conversation panel appears when it opens.
  panelEntrance: z.enum(["none", "fade", "scale", "slide-up", "slide-right"]).default("scale"),
  durationMs: z.number().int().min(80).max(1200).default(240),
}).default(ANIMATION_DEFAULTS);

const engagementSchema = z.object({
  headsUp: z.object({
    enabled: z.boolean(),
    type: z.enum(["text", "quick-replies"]),
    headline: z.string().trim().max(100),
    body: z.string().trim().max(300),
    showClose: z.boolean(),
    sound: z.boolean(),
    delaySeconds: z.number().int().min(0).max(3600),
  }),
  triggers: z.object({
    launcher: z.object({
      delaySeconds: z.number().int().min(0).max(3600),
      scrollPercent: z.number().int().min(0).max(100),
      exitIntent: z.boolean(),
    }),
    autoOpen: z.object({
      enabled: z.boolean(),
      delaySeconds: z.number().int().min(0).max(3600),
      surface: z.enum(["home", "chat", "voice", "callbacks"]),
    }),
    oncePerSession: z.boolean(),
    cooldownMinutes: z.number().int().min(0).max(10080),
  }),
  animation: animationSchema,
});

const targetingSchema = z.object({
  devices: z.object({ desktop: z.boolean(), mobile: z.boolean(), tablet: z.boolean() }),
  includePaths: z.array(z.string().trim().min(1).max(500)).max(50),
  excludePaths: z.array(z.string().trim().min(1).max(500)).max(50),
});

const decisionPrimitive = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

const decisionVariableSchema = z.object({
  id: z.string().trim().min(1).max(100),
  key: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,119}$/i, "Use a dot-separated context key"),
  label: z.string().trim().min(1).max(100),
  type: z.enum(["string", "number", "boolean"]),
  source: z.enum(["host", "query", "cookie", "data-layer"]),
});

const decisionConditionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  field: z.string().trim().min(1).max(120),
  operator: z.enum([
    "equals", "not-equals", "contains", "not-contains", "starts-with", "ends-with",
    "exists", "not-exists", "greater-than", "greater-or-equal", "less-than", "less-or-equal", "in",
  ]),
  value: decisionPrimitive,
});

const decisionActionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  type: z.enum([
    "visibility", "channels", "locale", "surface", "launcher-delay", "auto-open",
    "route-queue", "customer-label",
  ]),
  value: decisionPrimitive,
  valueLabel: z.string().trim().max(200).default(""),
});

const decisionsSchema = z.object({
  enabled: z.boolean(),
  strategy: z.literal("first-match"),
  variables: z.array(decisionVariableSchema).max(50),
  rules: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300),
    enabled: z.boolean(),
    priority: z.number().int().min(1).max(999),
    match: z.enum(["all", "any"]),
    conditions: z.array(decisionConditionSchema).min(1).max(20),
    actions: z.array(decisionActionSchema).min(1).max(12),
  })).max(100),
});

const previewBackgroundSchema = z.object({
  backgroundMode: z.enum(["schematic", "image"]),
  backgroundImageUrl: previewImageSource,
  backgroundFit: z.enum(["cover", "contain"]),
  backgroundPosition: z.enum(["top", "center", "bottom"]),
  overlayPercent: z.number().int().min(0).max(90),
});

const previewSchema = z.object({
  activeDeviceId: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
  orientation: z.enum(["portrait", "landscape"]),
  backgrounds: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_-]{0,100}$/),
    previewBackgroundSchema
  ),
  simulateDecisions: z.boolean().default(true),
  decisionContext: z.record(z.string().max(120), decisionPrimitive).default({}),
});

const callbackExperienceSchema = z.object({
  enabled: z.boolean().default(false),
  campaignKey: z.string().trim().min(1).max(100).default("default"),
  topics: z.array(z.object({
    key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i),
    label: z.string().trim().min(1).max(120),
  })).min(1).max(30),
  consentText: z.string().trim().min(1).max(512),
  consentPolicyVersion: z.string().trim().min(1).max(40),
  showSmsConsent: z.boolean().default(true),
  showEmailConsent: z.boolean().default(true),
  allowImmediate: z.boolean().default(true),
  allowScheduled: z.boolean().default(true),
  scheduleStepMinutes: z.number().int().min(5).max(60),
  minimumLeadMinutes: z.number().int().min(0).max(1440),
  maximumScheduleDays: z.number().int().min(1).max(30),
  availabilityWindowStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  availabilityWindowEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  maxCallbacksPerSlot: z.number().int().min(1).max(1000),
  copy: z.object({
    buttonLabel: z.string().trim().min(1).max(80),
    backToChatLabel: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(120),
    firstNameLabel: z.string().trim().min(1).max(80),
    lastNameLabel: z.string().trim().min(1).max(80),
    phoneLabel: z.string().trim().min(1).max(80),
    emailLabel: z.string().trim().min(1).max(80),
    topicLabel: z.string().trim().min(1).max(80),
    descriptionLabel: z.string().trim().min(1).max(80),
    immediateLabel: z.string().trim().min(1).max(80),
    scheduledLabel: z.string().trim().min(1).max(80),
    scheduleAtLabel: z.string().trim().min(1).max(80),
    submitLabel: z.string().trim().min(1).max(80),
    successTitle: z.string().trim().min(1).max(120),
    successBackLabel: z.string().trim().min(1).max(80),
  }),
}).superRefine((config, context) => {
  if (!config.allowImmediate && !config.allowScheduled) {
    context.addIssue({ code: "custom", path: ["allowImmediate"], message: "Enable at least one callback mode" });
  }
  if (config.availabilityWindowEnd <= config.availabilityWindowStart) {
    context.addIssue({ code: "custom", path: ["availabilityWindowEnd"], message: "Availability window must end after it starts" });
  }
  if (new Set(config.topics.map(({ key }) => key)).size !== config.topics.length) {
    context.addIssue({ code: "custom", path: ["topics"], message: "Callback topic keys must be unique" });
  }
});

export const DEFAULT_WIDGET_DECISION_RULES = Object.freeze([
  {
    id: "example-simple-hide-admin",
    name: "Simple · Hide on administration pages",
    description: "Hide the widget on internal administration paths.",
    enabled: true,
    priority: 10,
    match: "all",
    conditions: [
      { id: "example-simple-hide-admin-path", field: "page.path", operator: "starts-with", value: "/admin" },
    ],
    actions: [
      { id: "example-simple-hide-admin-visibility", type: "visibility", value: "hidden", valueLabel: "Hide widget" },
    ],
  },
  {
    id: "example-advanced-context-routing",
    name: "Advanced · Context-driven queue routing",
    description: "For an authenticated customer area, open messaging and route handoff using the queue supplied by the host page.",
    enabled: true,
    priority: 20,
    match: "all",
    conditions: [
      { id: "example-advanced-routing-auth", field: "customer.authenticated", operator: "equals", value: true },
      { id: "example-advanced-routing-name", field: "customer.name", operator: "exists", value: "" },
      { id: "example-advanced-routing-queue", field: "routing.queue", operator: "exists", value: "" },
    ],
    actions: [
      { id: "example-advanced-routing-channels", type: "channels", value: "messaging", valueLabel: "Messaging only" },
      { id: "example-advanced-routing-surface", type: "surface", value: "chat", valueLabel: "Chat" },
      { id: "example-advanced-routing-queue-action", type: "route-queue", value: "{{routing.queue}}", valueLabel: "Queue from routing.queue" },
      { id: "example-advanced-routing-label", type: "customer-label", value: "{{customer.name}}", valueLabel: "Customer name from context" },
    ],
  },
  {
    id: "example-advanced-vip-offer",
    name: "Advanced · VIP offer experience",
    description: "On selected commercial pages, give premium desktop and tablet visitors both channels and proactively open the widget.",
    enabled: true,
    priority: 30,
    match: "all",
    conditions: [
      { id: "example-advanced-vip-segment", field: "customer.segment", operator: "in", value: "vip, premium, private-banking" },
      { id: "example-advanced-vip-page", field: "page.path", operator: "in", value: "/pricing, /products, /offers" },
      { id: "example-advanced-vip-device", field: "device.type", operator: "in", value: "desktop, tablet" },
    ],
    actions: [
      { id: "example-advanced-vip-visibility", type: "visibility", value: "visible", valueLabel: "Show widget" },
      { id: "example-advanced-vip-channels", type: "channels", value: "both", valueLabel: "Messaging and voice" },
      { id: "example-advanced-vip-surface", type: "surface", value: "home", valueLabel: "Home" },
      { id: "example-advanced-vip-auto-open", type: "auto-open", value: 8, valueLabel: "After 8 seconds" },
    ],
  },
  {
    id: "example-standard-authenticated-welcome",
    name: "Standard · Welcome an authenticated customer",
    description: "Personalize the customer label and open chat after a short delay when a signed-in customer name is available.",
    enabled: true,
    priority: 40,
    match: "all",
    conditions: [
      { id: "example-standard-authenticated-auth", field: "customer.authenticated", operator: "equals", value: true },
      { id: "example-standard-authenticated-name", field: "customer.name", operator: "exists", value: "" },
    ],
    actions: [
      { id: "example-standard-authenticated-label", type: "customer-label", value: "{{customer.name}}", valueLabel: "Customer name from context" },
      { id: "example-standard-authenticated-surface", type: "surface", value: "chat", valueLabel: "Chat" },
      { id: "example-standard-authenticated-auto-open", type: "auto-open", value: 5, valueLabel: "After 5 seconds" },
    ],
  },
  {
    id: "example-simple-german-locale",
    name: "Simple · Match the visitor language",
    description: "Display the German widget translation when the browser locale starts with de.",
    enabled: true,
    priority: 50,
    match: "all",
    conditions: [
      { id: "example-simple-german-locale-condition", field: "visitor.locale", operator: "starts-with", value: "de" },
    ],
    actions: [
      { id: "example-simple-german-locale-action", type: "locale", value: "de-DE", valueLabel: "Deutsch · Deutschland" },
    ],
  },
]);

const DEFAULT_VOICE_AVATAR = Object.freeze({
  enabled: false,
  provider: "heygen",
  avatarId: null,
  name: "",
  previewUrl: "",
  portraitPreviewUrl: "",
  landscapePreviewUrl: "",
  avatarModel: "",
  displayFormat: "portrait",
  expandMode: "fullscreen",
  modalWidthPercent: DEFAULT_AVATAR_MODAL_WIDTH_PERCENT,
});
const catalogUrl = z.string().trim().max(2000).default("");
const voiceAvatarSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["heygen", "anam"]).default("heygen"),
  avatarId: z.string().trim().max(64).nullable().default(null),
  name: z.string().trim().max(120).default(""),
  previewUrl: catalogUrl,
  portraitPreviewUrl: catalogUrl,
  landscapePreviewUrl: catalogUrl,
  avatarModel: z.string().trim().max(64).default(""),
  displayFormat: z.enum(["portrait", "landscape"]).default("portrait"),
  // What the expand button opens: the whole screen or a centered modal that
  // takes 25%, 50% or 75% of the screen width.
  expandMode: z.enum(["fullscreen", "modal"]).default("fullscreen"),
  modalWidthPercent: z
    .number()
    .refine((value) => AVATAR_MODAL_WIDTH_OPTIONS.includes(value), "Modal width must be 25, 50 or 75")
    .default(DEFAULT_AVATAR_MODAL_WIDTH_PERCENT),
});

// A waiting-playlist entry: an HTTPS link, or a file from the video media
// library (served by /api/video/media/[id] with byte ranges).
const waitingMediaItem = z.object({
  source: z.enum(["url", "library"]).default("url"),
  url: z.string().trim().max(2000).default(""),
  mediaId: z.string().trim().max(64).default(""),
  label: z.string().trim().max(120).default(""),
}).superRefine((item, ctx) => {
  if (item.source === "library") { if (!item.mediaId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a file from the media library" }); return; }
  let parsed = null;
  try { parsed = new URL(item.url); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Waiting media must be a valid HTTPS URL" });
});
export const VIDEO_LAYOUTS = Object.freeze(["remote", "split", "pip", "spotlight"]);
export const VIDEO_MODAL_SIZES = Object.freeze({ small: 50, medium: 75, large: 90, fullscreen: 100 });
export const DEFAULT_VIDEO_CHANNEL = Object.freeze({
  enabled: false,
  routing: { queueId: "", queueName: "" },
  camera: "on",
  scenes: { available: ["remote", "split", "pip", "spotlight"], default: "pip", pipThumbnail: 30 },
  modal: { enabled: true, size: "medium" },
  sizing: { mode: "widget", width: 480, height: 640 },
  controls: { position: "bottom", overlay: { opacity: 35, size: "regular" } },
  notices: { enabled: true, seconds: 3 },
  allowScreenShare: false,
  recording: { enabled: true, layout: "pip" },
  waiting: { mode: "rotate", sound: true, items: [] },
});
// Phase 1 revisions stored `defaultLayout` and a bare `waitingMedia` list.
function migrateVideoChannel(value) {
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  if (!next.scenes && typeof next.defaultLayout === "string") next.scenes = { available: [...DEFAULT_VIDEO_CHANNEL.scenes.available], default: next.defaultLayout };
  if (!next.waiting && Array.isArray(next.waitingMedia)) {
    next.waiting = { mode: next.waitingMedia.length > 1 ? "rotate" : "loop", items: next.waitingMedia.map((item) => ({ source: "url", url: item?.url || "", label: item?.label || "" })) };
  }
  delete next.defaultLayout; delete next.waitingMedia;
  return next;
}
const videoChannelSchema = z.preprocess(migrateVideoChannel, z.object({
  enabled: z.boolean(),
  routing: z.object({
    queueId: z.string().trim().max(200).default(""),
    queueName: z.string().trim().max(200).default(""),
  }).default({ queueId: "", queueName: "" }),
  // Camera state proposed on the pre-join screen; the visitor can always change it.
  camera: z.enum(["on", "off"]).default("on"),
  // Scenes the visitor may switch between and the one applied when the other side connects.
  scenes: z.object({
    available: z.array(z.enum(VIDEO_LAYOUTS)).min(1).default([...DEFAULT_VIDEO_CHANNEL.scenes.available]),
    default: z.enum(VIDEO_LAYOUTS).default("pip"),
    // Width of the picture-in-picture thumbnails as a share of the main frame.
    pipThumbnail: z.number().int().min(10).max(50).default(30),
  }).default(DEFAULT_VIDEO_CHANNEL.scenes).transform((scenes) => ({ ...scenes, available: [...new Set(scenes.available)], default: scenes.available.includes(scenes.default) ? scenes.default : scenes.available[0] })),
  // The enlarge button and the modal width preset (share of the page width).
  modal: z.object({
    enabled: z.boolean().default(true),
    size: z.enum(["small", "medium", "large", "fullscreen"]).default("medium"),
  }).default(DEFAULT_VIDEO_CHANNEL.modal),
  // `widget` keeps the panel at `dimensions`; `video` resizes it while the video surface is open.
  sizing: z.object({
    mode: z.enum(["widget", "video"]).default("widget"),
    width: z.number().int().min(320).max(960).default(480),
    height: z.number().int().min(420).max(900).default(640),
  }).default(DEFAULT_VIDEO_CHANNEL.sizing),
  // Where the call controls are drawn: docked under a separator, above the scene, or over its bottom edge.
  controls: z.object({
    position: z.enum(["bottom", "top", "overlay"]).default("bottom"),
    // The floating panel: background opacity and button size.
    overlay: z.object({
      opacity: z.number().int().min(0).max(100).default(35),
      size: z.enum(["compact", "regular", "large"]).default("regular"),
    }).default(DEFAULT_VIDEO_CHANNEL.controls.overlay),
  }).default(DEFAULT_VIDEO_CHANNEL.controls),
  // Handoff notices (queued, assigned, connected) shown over the video frame.
  notices: z.object({
    enabled: z.boolean().default(true),
    // How long a notice stays on the frame before it hides.
    seconds: z.number().int().min(1).max(30).default(3),
  }).default(DEFAULT_VIDEO_CHANNEL.notices),
  allowScreenShare: z.boolean().default(false),
  recording: z.object({
    enabled: z.boolean().default(true),
    // Layout of the composed recording (Telnyx compositions allow two regions).
    layout: z.enum(["pip", "split"]).default("pip"),
  }).default({ enabled: true, layout: "pip" }),
  // Muted playlist while the visitor waits: one file in a loop or the list in rotation.
  waiting: z.object({
    mode: z.enum(["loop", "rotate"]).default("rotate"),
    // The visitor pressed Start call, so the playlist may play with sound.
    sound: z.boolean().default(true),
    items: z.array(waitingMediaItem).max(10).default([]),
  }).default(DEFAULT_VIDEO_CHANNEL.waiting),
}));

export const DEFAULT_COBROWSE = Object.freeze({
  enabled: false,
  entryPoints: { inSession: true, pairingCode: true },
  pairing: { seconds: 180 },
  consent: {
    text: "I agree to share this page with the support agent. I can stop sharing at any time.",
    policyVersion: "1.0",
  },
  privacy: {
    preset: "balanced",
    maskAllInputs: true,
    maskSelectors: [],
    blockSelectors: [],
  },
  control: { maxLevel: "observe" },
  indicator: { text: "Page sharing is active" },
  recording: { enabled: false },
});

const COBROWSE_SELECTOR_ATOM = String.raw`(?:[a-zA-Z][\w-]*|[.#][a-zA-Z_][\w-]*|\[[a-zA-Z][\w-]*(?:=(?:"[a-zA-Z0-9_ -]+"|'[a-zA-Z0-9_ -]+'|[a-zA-Z0-9_-]+))?\])`;
const COBROWSE_SELECTOR = new RegExp(`^${COBROWSE_SELECTOR_ATOM}(?:\\s*(?:>\\s*)?${COBROWSE_SELECTOR_ATOM})*$`);
export function isValidCobrowseSelector(value) {
  return typeof value === "string" && value.length <= 300 && COBROWSE_SELECTOR.test(value.trim());
}
const captureSelector = z.string().trim().min(1).max(300).refine(
  isValidCobrowseSelector, "Use a tag, class, id or attribute selector with optional descendants or >",
);

const cobrowseSchema = z.object({
  enabled: z.boolean(),
  entryPoints: z.object({ inSession: z.boolean(), pairingCode: z.boolean() }),
  pairing: z.object({ seconds: z.number().int().min(60).max(300) }),
  consent: z.object({ text: z.string().trim().min(20).max(1500), policyVersion: z.string().trim().min(1).max(40) }),
  privacy: z.object({
    preset: z.enum(["balanced", "strict"]),
    maskAllInputs: z.literal(true),
    maskSelectors: z.array(captureSelector).max(30),
    blockSelectors: z.array(captureSelector).max(30),
  }),
  control: z.object({ maxLevel: z.enum(["observe", "assist"]).default("observe") }).default({ maxLevel: "observe" }),
  indicator: z.object({ text: z.string().trim().min(4).max(100) }),
  recording: z.object({ enabled: z.literal(false) }),
});

export const widgetConfigSchema = z.object({
  schemaVersion: z.literal(2),
  locale: z.string().trim().min(2).max(20),
  allowedOrigins: z.array(allowedOrigin).max(50),
  cobrowse: cobrowseSchema.default(DEFAULT_COBROWSE),
  channels: z
    .object({
      messaging: z.object({
        enabled: z.boolean(),
        assistantId: z.string().trim().max(200),
        routing: z.object({
          queueId: z.string().trim().max(200),
          queueName: z.string().trim().max(200),
          queues: z
            .array(
              z.object({
                id: z.string().trim().min(1).max(200),
                name: z.string().trim().min(1).max(200),
              })
            )
            .max(50)
            .default([]),
        }),
      }),
      voice: z.object({
        enabled: z.boolean(),
        assistantId: z.string().trim().max(200),
        assistantVersionId: z.string().trim().max(200),
        connectionId: z.string().trim().max(200).default(""),
        destination: z.string().trim().max(500),
        destinationManaged: z.boolean().default(true),
        // With this on, publishing attaches the Invite and Skip Turn tools instead
        // of SIP Transfer, so the assistant stays on the call after the Contact Center
        // agent joins. Web calls only.
        keepAssistantOnCall: z.boolean().default(false),
        region: z
          .enum(["auto", "eu", "us-east", "us-central", "us-west", "ca-central", "apac", "south-asia"])
          .default("auto"),
        // Real-time avatar (HeyGen LiveAvatar / Anam) shown in the voice panel
        // (Widget Studio → Avatars). Catalog fields are copied from the
        // provider catalog when the avatar is selected.
        avatar: voiceAvatarSchema.default(DEFAULT_VOICE_AVATAR),
      }),
      // "Voice & Video Call": a Telnyx Video Rooms session routed straight to a
      // Contact Center queue (the internal documentation).
      video: videoChannelSchema.default(DEFAULT_VIDEO_CHANNEL),
    })
    .refine(
      (channels) => channels.messaging.enabled || channels.voice.enabled || channels.video.enabled,
      "At least one channel must be enabled"
    ),
  callbacks: callbackExperienceSchema,
  theme: themeSchema,
  dimensions: dimensionsSchema,
  components: componentsSchema,
  content: z.object({
    title: z.string().trim().min(1).max(100),
    messagingSubtitle: z.string().trim().max(160),
    voiceSubtitle: z.string().trim().max(160),
    welcomeMessage: z.string().trim().max(1000),
    chatLabel: z.string().trim().min(1).max(80),
    callLabel: z.string().trim().min(1).max(80),
    videoLabel: z.string().trim().min(1).max(80).default("Voice & Video Call"),
    videoSubtitle: z.string().trim().max(160).default("Talk to an agent over video"),
    videoWaitingMessage: z.string().trim().min(1).max(240).default("Please wait, we are connecting you with an agent."),
    videoConnectingMessage: z.string().trim().min(1).max(120).default("Connecting your video call…"),
    videoActiveMessage: z.string().trim().min(1).max(120).default("Call in progress"),
    videoEndedMessage: z.string().trim().min(1).max(160).default("The video call has ended."),
    videoErrorMessage: z.string().trim().min(1).max(240).default("The video call could not be started. Check camera and microphone access and try again."),
    joinVideoLabel: z.string().trim().min(1).max(80).default("Start call"),
    cameraOnLabel: z.string().trim().min(1).max(80).default("Turn camera on"),
    cameraOffLabel: z.string().trim().min(1).max(80).default("Turn camera off"),
    inputPlaceholder: z.string().trim().max(160),
    connectingMessage: z.string().trim().min(1).max(120).default("Łączenie…"),
    assistantTypingMessage: z.string().trim().min(1).max(120).default("Asystent odpowiada…"),
    agentTypingMessage: z.string().trim().min(1).max(120).default("Konsultant pisze…"),
    sendingMessage: z.string().trim().min(1).max(120).default("Wysyłanie…"),
    handoffWaitingMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Przekazujemy rozmowę do kolejki {queue}."),
    handoffAssignedMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Konsultant {agent} został przydzielony do rozmowy."),
    handoffConnectedMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Konsultant dołączył do rozmowy."),
    handoffDisconnectedMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Konsultant {agent} zakończył rozmowę. Ta sesja czatu jest już zamknięta."),
    handoffFailedMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Nie udało się przekazać rozmowy do konsultanta."),
    unavailableMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Czat jest chwilowo niedostępny. Spróbuj ponownie później."),
    sendFailedMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Nie udało się wysłać wiadomości. Spróbuj ponownie."),
    voiceReadyMessage: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .default("Gotowi do rozpoczęcia rozmowy."),
    voiceConnectingMessage: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .default("Łączenie z asystentem głosowym…"),
    voiceActiveMessage: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .default("Połączenie aktywne"),
    voiceListeningMessage: z.string().trim().min(1).max(80).default("słucham"),
    voiceThinkingMessage: z.string().trim().min(1).max(80).default("analizuję"),
    voiceSpeakingMessage: z.string().trim().min(1).max(80).default("odpowiadam"),
    voiceEndedMessage: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .default("Połączenie zakończone."),
    voiceErrorMessage: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .default("Nie udało się rozpocząć połączenia. Sprawdź dostęp do mikrofonu i spróbuj ponownie."),
    startCallLabel: z.string().trim().min(1).max(80).default("Rozpocznij połączenie"),
    endCallLabel: z.string().trim().min(1).max(80).default("Zakończ połączenie"),
    muteLabel: z.string().trim().min(1).max(80).default("Wycisz mikrofon"),
    unmuteLabel: z.string().trim().min(1).max(80).default("Włącz mikrofon"),
    privacyUrl: optionalHttpsUrl,
  }),
  avatars: z.object({
    customer: avatarSchema,
    bot: avatarSchema,
    human: humanAvatarSchema,
  }),
  features: z.object({
    emoji: z.boolean(),
    attachmentsAfterHandoff: z.boolean(),
    voiceTextInput: z.boolean(),
    voiceTranscript: z.boolean().default(true),
    attachmentPolicy: z.object({
      inboundMimeTypes: z.array(mimeType).max(80),
      outboundMimeTypes: z.array(mimeType).max(80),
      maximumFileSizeMb: z.number().int().min(1).max(100),
      showPreviewExamples: z.boolean(),
    }),
  }),
  behavior: z.object({
    persistSession: z.boolean(),
    inactivityMinutes: z.number().int().min(5).max(1440),
    mobileFullscreen: z.boolean(),
    defaultSurface: z.enum(["home", "chat", "voice", "video"]),
    reopenBehavior: z.enum(["resume", "new"]),
    autoFocusInput: z.boolean(),
  }),
  engagement: engagementSchema,
  targeting: targetingSchema,
  decisions: decisionsSchema,
  preview: previewSchema,
}).superRefine((config, context) => {
  for (const [name, avatar] of Object.entries(config.avatars)) {
    if (avatar.type === "image" && !/^https:\/\//i.test(avatar.value)) {
      context.addIssue({
        code: "custom",
        path: ["avatars", name, "value"],
        message: "Image avatars require an HTTPS URL",
      });
    }
  }
});

export const DEFAULT_WIDGET_CONFIG = Object.freeze({
  schemaVersion: 2,
  locale: "pl-PL",
  allowedOrigins: [],
  cobrowse: structuredClone(DEFAULT_COBROWSE),
  preview: {
    activeDeviceId: "desktop-responsive",
    orientation: "landscape",
    backgrounds: {
      "desktop-responsive__landscape": {
        backgroundMode: "schematic",
        backgroundImageUrl: "",
        backgroundFit: "cover",
        backgroundPosition: "top",
        overlayPercent: 0,
      },
    },
    simulateDecisions: true,
    decisionContext: {
      "page.path": "/support",
      "page.host": "customer.example.com",
      "visitor.locale": "pl-PL",
      "customer.segment": "standard",
      "customer.authenticated": false,
    },
  },
  channels: {
    messaging: {
      enabled: true,
      assistantId: "",
      routing: { queueId: "", queueName: "", queues: [] },
    },
    voice: {
      enabled: false,
      assistantId: "",
      assistantVersionId: "",
      connectionId: "",
      destination: "",
      destinationManaged: true,
      region: "auto",
      avatar: { ...DEFAULT_VOICE_AVATAR },
    },
    video: structuredClone(DEFAULT_VIDEO_CHANNEL),
  },
  callbacks: {
    enabled: false,
    campaignKey: "default",
    topics: [{ key: "general", label: "General enquiry" }],
    consentText: "I consent to being contacted by phone about this callback request.",
    consentPolicyVersion: "1.0",
    showSmsConsent: true,
    showEmailConsent: true,
    allowImmediate: true,
    allowScheduled: true,
    scheduleStepMinutes: 15,
    minimumLeadMinutes: 5,
    maximumScheduleDays: 30,
    availabilityWindowStart: "09:00",
    availabilityWindowEnd: "17:00",
    maxCallbacksPerSlot: 10,
    copy: {
      buttonLabel: "Schedule a call",
      backToChatLabel: "Back to chat",
      title: "Request a callback",
      firstNameLabel: "First name",
      lastNameLabel: "Last name",
      phoneLabel: "Phone number",
      emailLabel: "Email",
      topicLabel: "Conversation topic",
      descriptionLabel: "How can we help?",
      immediateLabel: "Immediate",
      scheduledLabel: "Choose time",
      scheduleAtLabel: "Callback time",
      submitLabel: "Request callback",
      successTitle: "Callback scheduled",
      successBackLabel: "Back to chat",
    },
  },
  theme: {
    colors: {
      primary: "#00e3aa",
      onPrimary: "#07130f",
      surface: "#ffffff",
      surfaceMuted: "#f4f7f6",
      text: "#111111",
      mutedText: "#66736d",
      border: "#d8dfdc",
      headerBackground: "#00e3aa",
      headerText: "#07130f",
      footerBackground: "#ffffff",
      footerText: "#111111",
      assistantBubble: "#111111",
      assistantText: "#ffffff",
      humanBubble: "#e9fff8",
      humanText: "#102a24",
      customerBubble: "#00e3aa",
      customerText: "#07130f",
      inputBackground: "#ffffff",
      inputText: "#111111",
    },
    typography: {
      fontFamily: "Inter",
      baseSize: 14,
      titleSize: 16,
      descriptionSize: 12,
      messageSize: 14,
      participantSize: 11,
      metaSize: 10,
    },
    shape: {
      panelRadius: 18,
      bubbleRadius: 16,
      inputRadius: 22,
      buttonRadius: 22,
    },
  },
  dimensions: {
    panelPosition: "bottom-right",
    panelOffsetX: 24,
    panelOffsetY: 24,
    launcherPosition: "bottom-right",
    launcherOffsetX: 24,
    launcherOffsetY: 24,
    panelWidth: 400,
    panelHeight: 640,
    headerHeight: 68,
    footerHeight: 68,
    fabSize: 60,
    headerPaddingX: 16,
    footerPaddingX: 12,
    messageMaxWidth: 78,
  },
  components: {
    header: {
      showIcon: true,
      showDescription: true,
      showClose: true,
      iconSize: 36,
      alignment: "left",
      icon: "bot",
      closeIcon: "x",
    },
    messages: {
      showAvatars: false,
      showParticipantNames: false,
      showTimestamps: true,
      showDeliveryStatus: true,
      avatarSize: 36,
      spacing: 12,
      assistantLabel: "AI Assistant",
      humanLabel: "Consultant",
      customerLabel: "You",
      typingIndicator: {
        rotatingMessages: true,
        alignment: "left",
        spinnerIcon: "loader-circle",
        backgroundColor: "#e8fff8",
        textColor: "#075e49",
        borderColor: "#a7f3d0",
        fontSize: 12,
      },
      agentTypingIndicator: {
        enabled: true,
        sendCustomerTyping: true,
        alignment: "left",
        spinnerIcon: "loader-circle",
        backgroundColor: "#f4f7f6",
        textColor: "#33413c",
        borderColor: "#d8dfdc",
        fontSize: 12,
      },
    },
    launcher: {
      style: "icon",
      icon: "message-circle",
      label: "Contact us",
      shape: "round",
      backgroundColor: "#00e3aa",
      textColor: "#07130f",
      showUnreadBadge: false,
      animation: "none",
    },
    voice: {
      statusBadge: {
        enabled: true,
        icon: "phone-call",
        listeningIcon: "mic",
        speakingIcon: "volume-2",
        thinkingIcon: "brain",
        backgroundColor: "#e8fff8",
        textColor: "#075e49",
        borderColor: "#a7f3d0",
        fontSize: 11,
        iconSize: 13,
        radius: 999,
      },
      controls: {
        buttonSize: 48,
        callButtonSize: 64,
        iconSize: 21,
        gap: 16,
        radius: 999,
        verticalPadding: 12,
        backgroundColor: "#ffffff",
        textColor: "#111111",
        borderColor: "#d8dfdc",
        activeBackgroundColor: "#f59e0b",
        activeTextColor: "#ffffff",
        callBackgroundColor: "#22c55e",
        callTextColor: "#ffffff",
        endBackgroundColor: "#ef4444",
        endTextColor: "#ffffff",
        muteIcon: "mic",
        unmuteIcon: "mic-off",
        callIcon: "phone",
        endCallIcon: "phone-off",
        speakerIcon: "volume-2",
        speakerMutedIcon: "volume-x",
      },
      waveform: {
        enabled: true,
        style: "bars",
        primaryColor: "#00e3aa",
        secondaryColor: "#007f63",
        backgroundColor: "#f4f7f6",
        bars: 32,
        smoothing: 0.78,
        amplitude: 1,
        glow: false,
        height: 96,
        radius: 16,
        padding: 12,
      },
      avatar: {
        maxHeight: 260,
        radius: 16,
        padding: 12,
        backgroundColor: "#f4f7f6",
        fit: "cover",
        focusY: 25,
        showExpandButton: true,
        position: "middle",
        showSubtitles: false,
        subtitleFontSize: 12,
        subtitlePosition: "bottom",
      },
    },
    footer: {
      buttonSize: 44,
      iconSize: 19,
      utilityButtonGap: 4,
      utilityInputGap: 8,
      inputSendGap: 8,
      attachmentIcon: "paperclip",
      emojiIcon: "smile",
      sendIcon: "send",
      buttonBackgroundColor: "#00e3aa",
      buttonTextColor: "#07130f",
    },
    handoff: {
      style: "divider",
      spacing: 10,
      iconSize: 16,
      fontSize: 11,
      radius: 999,
      queue: {
        enabled: true,
        icon: "arrow-right",
        backgroundColor: "#fff7ed",
        textColor: "#9a3412",
        borderColor: "#fed7aa",
      },
      assigned: {
        enabled: true,
        icon: "user-round-check",
        backgroundColor: "#eff6ff",
        textColor: "#1d4ed8",
        borderColor: "#bfdbfe",
      },
      disconnected: {
        enabled: true,
        icon: "phone-off",
        backgroundColor: "#f5f5f4",
        textColor: "#44403c",
        borderColor: "#d6d3d1",
      },
      connected: {
        enabled: true,
        icon: "headset",
        backgroundColor: "#ecfdf5",
        textColor: "#047857",
        borderColor: "#a7f3d0",
      },
      failed: {
        enabled: true,
        icon: "help-circle",
        backgroundColor: "#fef2f2",
        textColor: "#b91c1c",
        borderColor: "#fecaca",
      },
    },
    attachments: {
      documentIcon: "file-text",
      imageIcon: "image",
      backgroundColor: "#f4f7f6",
      textColor: "#111111",
      borderColor: "#d8dfdc",
      radius: 12,
      iconSize: 20,
      preview: { placement: "page", pageWidthPercent: DOCUMENT_PREVIEW_SIZE.widthPercent, pageHeightPercent: DOCUMENT_PREVIEW_SIZE.heightPercent },
    },
  },
  content: {
    title: "Jak możemy pomóc?",
    messagingSubtitle: "Rozmowa z konsultantem",
    voiceSubtitle: "Połączenie głosowe z asystentem AI",
    welcomeMessage: "Dzień dobry! W czym mogę pomóc?",
    chatLabel: "Chat with us",
    callLabel: "Call us",
    videoLabel: "Rozmowa głosowa i wideo",
    videoSubtitle: "Połącz się z konsultantem przez wideo",
    videoWaitingMessage: "Proszę czekać, łączymy z konsultantem.",
    videoConnectingMessage: "Łączenie rozmowy wideo…",
    videoActiveMessage: "Rozmowa w toku",
    videoEndedMessage: "Rozmowa wideo została zakończona.",
    videoErrorMessage: "Nie udało się rozpocząć rozmowy wideo. Sprawdź dostęp do kamery i mikrofonu i spróbuj ponownie.",
    joinVideoLabel: "Rozpocznij rozmowę",
    cameraOnLabel: "Włącz kamerę",
    cameraOffLabel: "Wyłącz kamerę",
    inputPlaceholder: "Napisz wiadomość…",
    connectingMessage: "Łączenie…",
    assistantTypingMessage: "Asystent odpowiada…",
    agentTypingMessage: "Konsultant pisze…",
    sendingMessage: "Wysyłanie…",
    handoffWaitingMessage: "Przekazujemy rozmowę do kolejki {queue}.",
    handoffAssignedMessage: "Konsultant {agent} został przydzielony do rozmowy.",
    handoffConnectedMessage: "Konsultant {agent} dołączył do rozmowy.",
    handoffDisconnectedMessage: "Konsultant {agent} zakończył rozmowę. Ta sesja czatu jest już zamknięta.",
    handoffFailedMessage: "Nie udało się przekazać rozmowy do konsultanta.",
    unavailableMessage: "Czat jest chwilowo niedostępny. Spróbuj ponownie później.",
    sendFailedMessage: "Nie udało się wysłać wiadomości. Spróbuj ponownie.",
    voiceReadyMessage: "Gotowi do rozpoczęcia rozmowy.",
    voiceConnectingMessage: "Łączenie z asystentem głosowym…",
    voiceActiveMessage: "Połączenie aktywne",
    voiceListeningMessage: "słucham",
    voiceThinkingMessage: "analizuję",
    voiceSpeakingMessage: "odpowiadam",
    voiceEndedMessage: "Połączenie zakończone.",
    voiceErrorMessage: "Nie udało się rozpocząć połączenia. Sprawdź dostęp do mikrofonu i spróbuj ponownie.",
    startCallLabel: "Rozpocznij połączenie",
    endCallLabel: "Zakończ połączenie",
    muteLabel: "Wycisz mikrofon",
    unmuteLabel: "Włącz mikrofon",
    privacyUrl: "",
  },
  avatars: {
    customer: { type: "initials", value: "TY" },
    bot: { type: "icon", value: "bot" },
    human: { type: "icon", value: "headset", useAgentProfilePicture: false },
  },
  features: {
    emoji: true,
    attachmentsAfterHandoff: true,
    voiceTextInput: true,
    voiceTranscript: true,
    attachmentPolicy: {
      inboundMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/markdown",
      ],
      outboundMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/markdown",
      ],
      maximumFileSizeMb: 10,
      showPreviewExamples: true,
    },
  },
  behavior: {
    persistSession: true,
    inactivityMinutes: 60,
    mobileFullscreen: true,
    defaultSurface: "home",
    reopenBehavior: "resume",
    autoFocusInput: true,
  },
  engagement: {
    headsUp: {
      enabled: false,
      type: "text",
      headline: "Hi there! 👋",
      body: "How can we help you today?",
      showClose: true,
      sound: false,
      delaySeconds: 8,
    },
    triggers: {
      launcher: { delaySeconds: 0, scrollPercent: 0, exitIntent: false },
      autoOpen: { enabled: false, delaySeconds: 0, surface: "home" },
      oncePerSession: true,
      cooldownMinutes: 0,
    },
    animation: { ...ANIMATION_DEFAULTS },
  },
  targeting: {
    devices: { desktop: true, mobile: true, tablet: true },
    includePaths: [],
    excludePaths: [],
  },
  decisions: {
    enabled: false,
    strategy: "first-match",
    variables: [
      { id: "customer-segment", key: "customer.segment", label: "Customer segment", type: "string", source: "host" },
      { id: "customer-authenticated", key: "customer.authenticated", label: "Authenticated customer", type: "boolean", source: "host" },
      { id: "customer-name", key: "customer.name", label: "Customer name", type: "string", source: "host" },
      { id: "queue-name", key: "routing.queue", label: "Preferred queue", type: "string", source: "host" },
    ],
    rules: DEFAULT_WIDGET_DECISION_RULES,
  },
});

export function createDefaultWidgetConfig(locale = "en-US") {
  const config = localizeWidgetConfig(DEFAULT_WIDGET_CONFIG, locale);
  config.preview.decisionContext["visitor.locale"] = config.locale;
  config.avatars.customer.value = config.components.messages.customerLabel.toLocaleUpperCase(config.locale).slice(0, 3);
  return config;
}

function mergeWidgetConfigDefaults(defaultValue, suppliedValue) {
  if (suppliedValue === undefined) return structuredClone(defaultValue);
  if (
    defaultValue && suppliedValue &&
    typeof defaultValue === "object" && typeof suppliedValue === "object" &&
    !Array.isArray(defaultValue) && !Array.isArray(suppliedValue)
  ) {
    return Object.fromEntries(
      [...new Set([...Object.keys(defaultValue), ...Object.keys(suppliedValue)])]
        .map((key) => [key, mergeWidgetConfigDefaults(defaultValue[key], suppliedValue[key])])
    );
  }
  return structuredClone(suppliedValue);
}

export function migrateWidgetConfigV1(value) {
  if (value?.schemaVersion !== 1) return value;
  const legacy = structuredClone(value);
  const migrated = mergeWidgetConfigDefaults(DEFAULT_WIDGET_CONFIG, legacy);
  const appearance = legacy.appearance || {};

  migrated.schemaVersion = 2;
  migrated.dimensions = {
    ...migrated.dimensions,
    panelPosition: appearance.position || migrated.dimensions.panelPosition,
    launcherPosition: appearance.position || migrated.dimensions.launcherPosition,
    panelWidth: appearance.panelWidth ?? migrated.dimensions.panelWidth,
    panelHeight: appearance.panelHeight ?? migrated.dimensions.panelHeight,
    fabSize: appearance.fabSize ?? migrated.dimensions.fabSize,
    panelOffsetX: appearance.offsetX ?? migrated.dimensions.panelOffsetX,
    panelOffsetY: appearance.offsetY ?? migrated.dimensions.panelOffsetY,
    launcherOffsetX: appearance.offsetX ?? migrated.dimensions.launcherOffsetX,
    launcherOffsetY: appearance.offsetY ?? migrated.dimensions.launcherOffsetY,
  };
  migrated.theme.shape.panelRadius = appearance.borderRadius ?? migrated.theme.shape.panelRadius;
  migrated.theme.colors.primary = appearance.primaryColor || migrated.theme.colors.primary;
  migrated.theme.colors.headerBackground = appearance.primaryColor || migrated.theme.colors.headerBackground;
  migrated.theme.colors.customerBubble = appearance.primaryColor || migrated.theme.colors.customerBubble;
  migrated.theme.colors.surface = appearance.surfaceColor || migrated.theme.colors.surface;
  migrated.theme.colors.footerBackground = appearance.surfaceColor || migrated.theme.colors.footerBackground;
  migrated.theme.colors.text = appearance.textColor || migrated.theme.colors.text;
  migrated.theme.colors.footerText = appearance.textColor || migrated.theme.colors.footerText;
  migrated.theme.colors.customerBubble = appearance.userMessageColor || migrated.theme.colors.customerBubble;
  migrated.components.messages.showTimestamps =
    legacy.features?.timestamps ?? migrated.components.messages.showTimestamps;
  return migrated;
}

export function parseWidgetConfig(value) {
  const normalized = structuredClone(migrateWidgetConfigV1(value));
  if (normalized && !normalized.cobrowse) normalized.cobrowse = structuredClone(DEFAULT_COBROWSE);
  if (normalized?.theme && !normalized.preview) {
    normalized.preview = structuredClone(DEFAULT_WIDGET_CONFIG.preview);
  } else if (normalized?.preview && !normalized.preview.backgrounds) {
    const legacy = normalized.preview;
    normalized.preview = {
      activeDeviceId: "desktop-responsive",
      orientation: "landscape",
      backgrounds: {
        "desktop-responsive__landscape": {
          backgroundMode: legacy.backgroundMode || "schematic",
          backgroundImageUrl: legacy.backgroundImageUrl || "",
          backgroundFit: legacy.backgroundFit || "cover",
          backgroundPosition: legacy.backgroundPosition || "top",
          overlayPercent: legacy.overlayPercent ?? 0,
        },
      },
    };
  }
  if (normalized?.preview) {
    normalized.preview.simulateDecisions ??= true;
    normalized.preview.decisionContext ??= structuredClone(DEFAULT_WIDGET_CONFIG.preview.decisionContext);
  }
  normalized.decisions ??= structuredClone(DEFAULT_WIDGET_CONFIG.decisions);
  normalized.callbacks ??= structuredClone(DEFAULT_WIDGET_CONFIG.callbacks);
  normalized.callbacks.availabilityWindowStart ??=
    normalized.callbacks.immediateWindowStart ?? DEFAULT_WIDGET_CONFIG.callbacks.availabilityWindowStart;
  normalized.callbacks.availabilityWindowEnd ??=
    normalized.callbacks.immediateWindowEnd ?? DEFAULT_WIDGET_CONFIG.callbacks.availabilityWindowEnd;
  normalized.callbacks.maxCallbacksPerSlot ??= DEFAULT_WIDGET_CONFIG.callbacks.maxCallbacksPerSlot;
  const dimensions = normalized?.dimensions;
  if (dimensions) {
    const legacyPosition = dimensions.position || "bottom-right";
    const legacyOffsetX = dimensions.offsetX ?? 24;
    const legacyOffsetY = dimensions.offsetY ?? 24;
    dimensions.panelPosition ??= legacyPosition;
    dimensions.panelOffsetX ??= legacyOffsetX;
    dimensions.panelOffsetY ??= legacyOffsetY;
    dimensions.launcherPosition ??= legacyPosition;
    dimensions.launcherOffsetX ??= legacyOffsetX;
    dimensions.launcherOffsetY ??= legacyOffsetY;
  }
  const routing = normalized?.channels?.messaging?.routing;
  if (routing && (!Array.isArray(routing.queues) || !routing.queues.length)) {
    routing.queues = routing.queueId
      ? [{ id: routing.queueId, name: routing.queueName || routing.queueId }]
      : [];
  }
  if (routing?.queues?.length && !routing.queueId) {
    routing.queueId = routing.queues[0].id;
    routing.queueName = routing.queues[0].name;
  }
  if (normalized.components?.launcher?.icon) {
    normalized.components.launcher.icon = normalizeWidgetIconId(normalized.components.launcher.icon);
  }
  if (normalized.components?.footer) {
    normalized.components.footer.utilityButtonGap ??= DEFAULT_WIDGET_CONFIG.components.footer.utilityButtonGap;
    normalized.components.footer.utilityInputGap ??= DEFAULT_WIDGET_CONFIG.components.footer.utilityInputGap;
    normalized.components.footer.inputSendGap ??= DEFAULT_WIDGET_CONFIG.components.footer.inputSendGap;
  }
  if (normalized.components?.messages && !normalized.components.messages.typingIndicator) {
    normalized.components.messages.typingIndicator =
      structuredClone(DEFAULT_WIDGET_CONFIG.components.messages.typingIndicator);
  }
  if (normalized.components?.messages && !normalized.components.messages.agentTypingIndicator) {
    normalized.components.messages.agentTypingIndicator =
      structuredClone(DEFAULT_WIDGET_CONFIG.components.messages.agentTypingIndicator);
  }
  if (normalized.components?.messages?.typingIndicator?.spinnerIcon) {
    normalized.components.messages.typingIndicator.spinnerIcon = normalizeWidgetIconId(
      normalized.components.messages.typingIndicator.spinnerIcon,
      DEFAULT_WIDGET_CONFIG.components.messages.typingIndicator.spinnerIcon
    );
  }
  if (normalized.components?.messages?.agentTypingIndicator?.spinnerIcon) {
    normalized.components.messages.agentTypingIndicator.spinnerIcon = normalizeWidgetIconId(
      normalized.components.messages.agentTypingIndicator.spinnerIcon,
      DEFAULT_WIDGET_CONFIG.components.messages.agentTypingIndicator.spinnerIcon
    );
  }
  if (normalized.components && !normalized.components.handoff) {
    normalized.components.handoff = structuredClone(DEFAULT_WIDGET_CONFIG.components.handoff);
  }
  if (normalized.content) {
    normalized.content.agentTypingMessage ??= DEFAULT_WIDGET_CONFIG.content.agentTypingMessage;
    normalized.content.handoffAssignedMessage ??= DEFAULT_WIDGET_CONFIG.content.handoffAssignedMessage;
    normalized.content.handoffDisconnectedMessage ??= DEFAULT_WIDGET_CONFIG.content.handoffDisconnectedMessage;
  }
  if (normalized.components?.voice?.statusBadge) {
    const badge = normalized.components.voice.statusBadge;
    const defaults = DEFAULT_WIDGET_CONFIG.components.voice.statusBadge;
    badge.listeningIcon ??= defaults.listeningIcon;
    badge.speakingIcon ??= defaults.speakingIcon;
    badge.thinkingIcon ??= defaults.thinkingIcon;
  }
  if (normalized.engagement) {
    normalized.engagement.animation ??= { ...ANIMATION_DEFAULTS };
  }
  if (normalized.components?.handoff) {
    normalized.components.handoff.disconnected ??=
      structuredClone(DEFAULT_WIDGET_CONFIG.components.handoff.disconnected);
  }
  for (const event of Object.values(normalized.components?.handoff || {})) {
    if (event?.icon) event.icon = normalizeWidgetIconId(event.icon, "help-circle");
  }
  for (const avatar of Object.values(normalized.avatars || {})) {
    if (avatar?.type === "icon") avatar.value = normalizeWidgetIconId(avatar.value, "user");
  }
  return widgetConfigSchema.parse(normalized);
}

export function parseWidgetConfigIfCurrent(value) {
  if (![1, 2].includes(value?.schemaVersion)) return null;
  try {
    return parseWidgetConfig(value);
  } catch (error) {
    if (error instanceof z.ZodError) return null;
    throw error;
  }
}

export function widgetQueues(config) {
  const routing = parseWidgetConfig(config).channels.messaging.routing;
  const candidates = routing.queues.length
    ? routing.queues
    : routing.queueId
      ? [{ id: routing.queueId, name: routing.queueName || routing.queueId }]
      : [];
  return [...new Map(candidates.map((queue) => [queue.id, queue])).values()];
}

export function applyWidgetInfrastructure(value, {
  queues = [],
  defaultQueue = null,
} = {}) {
  const config = structuredClone(parseWidgetConfig(value));
  const normalizedQueues = queues
    .map((queue) => ({ id: String(queue?.id || "").trim(), name: String(queue?.name || "").trim() }))
    .filter((queue) => queue.id && queue.name);
  const selectedDefault = defaultQueue?.id
    ? normalizedQueues.find((queue) => queue.id === defaultQueue.id) || {
      id: String(defaultQueue.id).trim(),
      name: String(defaultQueue.name || defaultQueue.id).trim(),
    }
    : normalizedQueues[0] || null;

  if (normalizedQueues.length) config.channels.messaging.routing.queues = normalizedQueues;
  if (selectedDefault?.id) {
    config.channels.messaging.routing.queueId = selectedDefault.id;
    config.channels.messaging.routing.queueName = selectedDefault.name;
  }
  return config;
}

export function normalizeWidgetAssistantConfig(value) {
  const config = parseWidgetConfig(value);
  const { messaging, voice } = config.channels;
  if (messaging.assistantId && voice.assistantId && messaging.assistantId !== voice.assistantId) {
    throw Object.assign(new Error("Messaging and Voice must use the same Widget AI assistant; select one assistant for this widget"), { status: 400 });
  }
  const assistantId = messaging.assistantId || voice.assistantId;
  messaging.assistantId = assistantId;
  voice.assistantId = assistantId;
  return config;
}

export function assertPublishableWidgetConfig(value) {
  const config = normalizeWidgetAssistantConfig(value);
  const issues = [];
  if (!config.allowedOrigins.length) issues.push("At least one embedding origin is required");
  if (config.channels.messaging.enabled && !config.channels.messaging.assistantId) {
    if (!config.channels.messaging.routing.queueId) issues.push("Select an AI assistant or a Contact Center chat queue");
    if (!widgetQueues(config).some(queue => queue.id === config.channels.messaging.routing.queueId)) issues.push("Default queue must belong to the widget routing allowlist");
  }
  if (config.channels.voice.enabled && !config.channels.voice.assistantId) issues.push("Select a Voice AI assistant");
  if (config.channels.video.enabled && !config.channels.video.routing.queueId) issues.push("Select a Contact Center video queue");
  if (config.callbacks.enabled) issues.push("Callbacks are scheduled with the WebRTC widget delivery");
  if (config.cobrowse.enabled) {
    for (const selector of [...config.cobrowse.privacy.maskSelectors, ...config.cobrowse.privacy.blockSelectors]) {
      if (!isValidCobrowseSelector(selector)) issues.push(`Invalid co-browse selector: ${selector}`);
    }
  }
  if (issues.length) throw Object.assign(new Error(issues.join("; ")), { status: 400 });
  return config;
}

export function publicWidgetConfig(config, { voiceCallerNumber = "" } = {}) {
  const parsed = parseWidgetConfig(config);
  const decisionLocaleIds = [
    parsed.locale,
    ...parsed.decisions.rules.flatMap((rule) =>
      rule.actions
        .filter((action) => action.type === "locale" && typeof action.value === "string")
        .map((action) => action.value)
    ),
  ];
  const decisionLocales = Object.fromEntries(
    [...new Set(decisionLocaleIds)].map((locale) => {
      const localized = locale === parsed.locale
        ? parsed
        : localizeWidgetConfig(parsed, locale);
      return [localized.locale, {
        content: localized.content,
        messages: localized.components.messages,
        launcher: localized.components.launcher,
        headsUp: localized.engagement.headsUp,
      }];
    })
  );
  return {
    schemaVersion: parsed.schemaVersion,
    locale: parsed.locale,
    cobrowse: parsed.cobrowse,
    channels: {
      messaging: { enabled: parsed.channels.messaging.enabled, runtime: parsed.channels.messaging.assistantId ? "assistant" : "queue" },
      voice: {
        enabled: parsed.channels.voice.enabled,
        assistantId: parsed.channels.voice.assistantId,
        assistantVersionId: parsed.channels.voice.assistantVersionId,
        region: parsed.channels.voice.region,
        callerNumber: parsed.channels.voice.enabled ? String(voiceCallerNumber).trim() : "",
        // Public subset of the avatar block: no provider model id, normalized preview URLs.
        avatar: publicAIMediaSettings(parsed.channels.voice.enabled ? parsed.channels.voice.avatar : {}),
      },
      video: {
        enabled: parsed.channels.video.enabled,
        camera: parsed.channels.video.camera,
        scenes: parsed.channels.video.scenes,
        modal: parsed.channels.video.modal,
        sizing: parsed.channels.video.sizing,
        controls: parsed.channels.video.controls,
        notices: parsed.channels.video.notices,
        allowScreenShare: parsed.channels.video.allowScreenShare,
        recording: parsed.channels.video.recording.enabled,
        // Library files resolve to the ranged media route; storage stays private.
        waiting: { mode: parsed.channels.video.waiting.mode, sound: parsed.channels.video.waiting.sound, items: parsed.channels.video.enabled
          ? parsed.channels.video.waiting.items.map((item) => ({ url: item.source === "library" ? `/api/video/media/${encodeURIComponent(item.mediaId)}` : item.url, label: item.label }))
          : [] },
      },
    },
    theme: parsed.theme,
    dimensions: parsed.dimensions,
    components: parsed.components,
    content: parsed.content,
    avatars: parsed.avatars,
    features: parsed.features,
    behavior: parsed.behavior,
    engagement: parsed.engagement,
    targeting: parsed.targeting,
    decisions: parsed.decisions,
    decisionLocales,
  };
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    // An opaque origin ("null", a non-web scheme) is never an embedding origin.
    return /^https?:$/.test(url.protocol) ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Sessions started from the signed-in widget test page carry this marker in
// front of the page origin. It only ever comes out of a bootstrap token minted
// for a verified test grant, never from a request header, and it keeps test
// traffic recognisable in the interaction attributes.
export const WIDGET_TEST_ORIGIN_PREFIX = "cc-test:";

export function widgetTestOrigin(origin) {
  return `${WIDGET_TEST_ORIGIN_PREFIX}${origin}`;
}

export function isWidgetTestOrigin(origin) {
  return typeof origin === "string" && origin.startsWith(WIDGET_TEST_ORIGIN_PREFIX);
}

// Origin check for a signed bootstrap token or a stored session.
export function isWidgetSessionOriginAllowed(origin, allowedOrigins) {
  return isWidgetTestOrigin(origin) || isWidgetOriginAllowed(origin, allowedOrigins);
}

export function isWidgetOriginAllowed(origin, allowedOrigins) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const url = new URL(normalized);

  return allowedOrigins.some((entry) => {
    const candidate = String(entry || "").trim().toLowerCase();
    if (!candidate) return false;
    if (candidate === normalized) return true;

    const wildcard = candidate.match(/^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/);
    if (!wildcard) return false;
    const [, protocol, suffix, port] = wildcard;
    return (
      url.protocol === `${protocol}:` &&
      url.hostname.endsWith(`.${suffix}`) &&
      url.hostname !== suffix &&
      (!port || url.port === port)
    );
  });
}
