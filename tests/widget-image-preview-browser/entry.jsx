import React from 'react';
import { createRoot } from 'react-dom/client';
import WidgetFrame from '../../components/widget/WidgetFrame.jsx';
import { createDefaultWidgetConfig } from '../../lib/widgets/config.js';

const config = createDefaultWidgetConfig('en-US');
config.channels.messaging.aiImages = true;
config.features.attachmentPolicy.showPreviewExamples = true;
const root = createRoot(document.getElementById('root'));
window.unmountPreview = () => root.unmount();
root.render(<WidgetFrame previewWidget={{ id: 'image-preview', config }} />);
