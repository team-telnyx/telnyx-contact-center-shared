"use client";

import Image from "next/image";
import { useAppSettings } from "@/hooks/use-app-settings";

export function AuthRightImage() {
  const { authRightImageUri, loading } = useAppSettings();

  if (loading) {
    return (
      <Image
        src="/auth_right_image.png"
        alt="Contact Center"
        className="absolute inset-0 h-full w-full object-cover grayscale"
        width={1000}
        height={1000}
        style={{ width: "100%", height: "100%" }}
        priority
      />
    );
  }

  if (authRightImageUri) {
    return (
      <img
        src={authRightImageUri}
        alt="Contact Center"
        className="absolute inset-0 h-full w-full object-cover grayscale"
        style={{ width: "100%", height: "100%" }}
      />
    );
  }

  return (
    <Image
      src="/auth_right_image.png"
      alt="Contact Center"
      className="absolute inset-0 h-full w-full object-cover grayscale"
      width={1000}
      height={1000}
      style={{ width: "100%", height: "100%" }}
      priority
    />
  );
}
