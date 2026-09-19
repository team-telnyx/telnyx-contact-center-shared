"use client";

import { AnamAvatarStage } from "@/components/avatar/anam-avatar-stage";
import { HeyGenAvatarStage } from "@/components/avatar/heygen-avatar-stage";
import { ANAM_AVATAR_PROVIDER } from "@/lib/ai/avatar-config.mjs";

export function AIAvatarStage(props) {
  if (props.avatarConfig?.provider === ANAM_AVATAR_PROVIDER) {
    return <AnamAvatarStage {...props} />;
  }
  return <HeyGenAvatarStage {...props} />;
}
