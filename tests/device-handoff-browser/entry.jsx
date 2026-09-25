import React from 'react';
import {createRoot} from 'react-dom/client';
import {DeviceHandoff} from '../../components/contact-center/DeviceHandoff';
createRoot(document.getElementById('root')).render(<DeviceHandoff interactionId="call" onJoinVideo={async()=>{window.joined=true;}}/>);
