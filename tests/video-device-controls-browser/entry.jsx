import React from 'react';
import {createRoot} from 'react-dom/client';
import MessagingInteractionActions from '../../components/contact-center/MessagingInteractionActions';
import {TooltipProvider} from '../../components/ui/tooltip';
const root=createRoot(document.getElementById('root'));
window.renderInteraction=state=>root.render(<TooltipProvider delayDuration={0}><MessagingInteractionActions interaction={{id:'test-video',channel:'video',state,version:'1'}}/></TooltipProvider>);
window.renderInteraction('ringing');
