"use client";

import { notify } from "@/components/ToastNotify";

function descriptionFromOptions(options) {
  return typeof options?.description === "string" ? options.description : undefined;
}

export const toast = {
  success(title, options) {
    return notify({ title, description: descriptionFromOptions(options), variant: "success" });
  },
  error(title, options) {
    return notify({ title, description: descriptionFromOptions(options), variant: "error" });
  },
};
