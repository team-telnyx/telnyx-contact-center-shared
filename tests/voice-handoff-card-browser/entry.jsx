import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentDesktop} from '../../components/contact-center/AgentDesktop';
import {TooltipProvider} from '../../components/ui/tooltip';
import calls from '../../lib/stores/calls-store';
import active from '../../lib/stores/active-call-store';
window.localLegEnded=()=>{
 active.setState({call:{id:'old-leg'},status:'ended',contactCenter:{interactionId:'work'},disconnectedTime:Date.now()});
 window.dispatchEvent(new CustomEvent('contact-center:call-disconnected',{detail:{interactionId:'work',callControlId:'old-leg'}}));
 calls.getState().removeCall('old-leg');
 active.getState().clearActiveCall();
};
createRoot(document.getElementById('root')).render(<TooltipProvider><AgentDesktop/></TooltipProvider>);
