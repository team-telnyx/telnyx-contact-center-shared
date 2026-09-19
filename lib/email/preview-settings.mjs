export const DEFAULT_EMAIL_PREVIEW_SETTINGS = Object.freeze({
  format: 'text',
  loadRemoteImages: false,
  showInlineImages: true,
});

export function emailPreviewSettings(value) {
  return {
    format: value?.format === 'html' ? 'html' : 'text',
    loadRemoteImages: value?.loadRemoteImages === true,
    showInlineImages: typeof value?.showInlineImages === 'boolean' ? value.showInlineImages : true,
  };
}

export function parseEmailPreviewSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['text', 'html'].includes(value.format)
    || typeof value.loadRemoteImages !== 'boolean' || typeof value.showInlineImages !== 'boolean'
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_EMAIL_PREVIEW_SETTINGS, key))) {
    throw Object.assign(new Error('Select an email format and valid image preferences'), { status: 400 });
  }
  return emailPreviewSettings(value);
}

export async function loadEmailPreviewSettings(db) {
  const result = await db.query("SELECT cc_settings->'email_preview' AS preview FROM app_settings WHERE id='default'");
  return emailPreviewSettings(result.rows[0]?.preview);
}
