// Device model names are product names; the generic desktop preset is UI copy.
export function previewDeviceLabel(tUi, device) {
  return device?.id === 'desktop-responsive' && device.name === 'Desktop'
    ? tUi('Desktop', undefined, 'preview device')
    : device?.name;
}
