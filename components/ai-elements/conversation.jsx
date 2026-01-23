"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Conversation = forwardRef(
  ({ className, initial = false, resize = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("relative flex-1 overflow-y-auto", className)}
      role="log"
      {...props}
    />
  )
);

Conversation.displayName = "Conversation";

export const ConversationContent = ({ className, ...props }) => (
  <div className={cn("p-4", className)} {...props} />
);

