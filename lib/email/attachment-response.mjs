import { emailRasterType } from './content.mjs';
import { attachmentResponse, validateAttachment } from '../widgets/attachments.js';
import { documentPreviewKind } from '../documents/preview-types.mjs';
import { normalizeAttachmentMimeType } from '../widgets/attachment-types.mjs';

const unavailable = (message, status = 415) => Object.assign(new Error(message), { status });

// Call only after authorizing the interaction and resolving its retained file.
// Downloads keep their original bytes; preview is an explicit, private request.
export async function emailAttachmentResponse(request, { file, bytes, conversationId }) {
  const url = new URL(request.url);
  const name = String(file.filename || file.name || 'attachment')
    .replace(/[\u0000-\u001f\u007f\\/]/g, '_').slice(0, 180);
  const raster = emailRasterType(bytes);
  if (url.searchParams.get('preview') === '1') {
    const type = raster || normalizeAttachmentMimeType(file.content_type, name);
    const documentKind = documentPreviewKind(type, name);
    const attachment = { name, bytes, byte_size: bytes.length, content_type: type, conversation_id: conversationId };
    if (documentKind && documentKind !== 'pdf') {
      return attachmentResponse(request, attachment);
    }
    // Validate media bytes before using their declared type for inline display.
    // SVG, HTML and unknown formats remain download-only.
    if (!raster && type !== 'application/pdf' && !/^(audio\/|video\/)/.test(type)) {
      throw unavailable('This attachment is available as a download only');
    }
    try { validateAttachment(bytes, type); }
    catch { throw unavailable('This attachment cannot be previewed'); }
    url.searchParams.delete('preview');
    return attachmentResponse(new Request(url, { headers: request.headers }), attachment);
  }
  const inline = url.searchParams.get('inline') === '1';
  if (inline && (!raster || bytes.length > 5_000_000)) {
    throw unavailable('This attachment is available as a download only');
  }
  return new Response(bytes, { headers: {
    'Content-Type': inline ? raster : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
