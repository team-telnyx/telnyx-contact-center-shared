"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Paperclip } from 'lucide-react';
import ChatAttachments from '@/components/contact-center/ChatAttachments';

export default function EmailAttachments({ files = [] }) {
  const tUi = useUiText();
  if (!files.length) return null;
  return <div className="space-y-2">
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Paperclip className="size-3.5"/>{tUi("Attachments (")}{files.length})</p>
    <ChatAttachments presentation="files" files={files.map(file => ({ ...file,
      name: file.name || file.filename || 'Attachment', byte_size: file.byte_size ?? file.size_bytes,
      previewUrl: `${file.url}${file.url.includes('?') ? '&' : '?'}preview=1`,
    }))}/>
  </div>;
}
