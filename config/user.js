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

const USER_ROLE_RANK = new Map(
  USER_ROLES.map((role, index) => [role.value, index]),
);

export function sortUserRoles(roles = []) {
  return [...roles].sort((left, right) => {
    const leftValue = String(left || "").toLowerCase();
    const rightValue = String(right || "").toLowerCase();
    const leftRank = USER_ROLE_RANK.get(leftValue) ?? USER_ROLES.length;
    const rightRank = USER_ROLE_RANK.get(rightValue) ?? USER_ROLES.length;
    return leftRank - rightRank || leftValue.localeCompare(rightValue);
  });
}
