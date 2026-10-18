import React from 'react';
import {createRoot} from 'react-dom/client';
import {DeviceHandoffDialog} from '../../components/contact-center/handoff/DeviceHandoffDialog';
import useDeviceHandoffStore from '../../lib/stores/device-handoff-store';
import useActiveCallStore from '../../lib/stores/active-call-store';
window.handoffStore = useDeviceHandoffStore;
window.callStore = useActiveCallStore;
createRoot(document.getElementById('root')).render(<><button id="outside" type="button">Outside</button><DeviceHandoffDialog/></>);
