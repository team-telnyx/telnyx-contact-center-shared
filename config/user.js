import {
  IconHeadset,
  IconVideo,
  IconDeviceMobile,
  IconMail,
  IconUser,
  IconUserCircle,
  IconUserCheck,
  IconShieldLock,
  IconCrown,
  IconCheck,
  IconClock,
  IconX,
  IconCircleOff,
} from "@tabler/icons-react";

export const USER_STATUS_OPTIONS = [
  { value: "Available", Icon: IconCheck },
  { value: "On Queue", Icon: IconClock },
  { value: "Busy", Icon: IconX },
  { value: "Away", Icon: IconCircleOff },
  { value: "Off Queue", Icon: IconCircleOff },
];

export const DEFAULT_USER_STATUS = "Available";

export const USER_ROLES = [
  { value: "agent", label: "Agent", Icon: IconHeadset },
  { value: "supervisor", label: "Supervisor", Icon: IconUserCheck },
  { value: "admin", label: "Admin", Icon: IconShieldLock },
  { value: "owner", label: "Owner", Icon: IconCrown },
];
