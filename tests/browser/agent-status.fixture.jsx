import './process-shim.js';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StatusSelector} from '../../components/contact-center/StatusSelector';

const fixture=window.fixture={changes:[]};
const statuses=[
  {name:'Available',user_selectable:true,icon:'check',color:'#16a34a'},
  {name:'Away',user_selectable:true,icon:'clock',color:'#ca8a04'},
  {name:'Break',user_selectable:true,icon:'coffee'},
  {name:'Busy',user_selectable:false,icon:'phone',color:'#ea580c'},
];
window.fetch=async()=>({ok:true,json:async()=>({statuses})});
function App(){
  const [state,setState]=useState({value:'Busy',pendingStatus:'Away',pendingSince:'2026-09-15T09:30:00.000Z'});
  fixture.setState=setState;
  return <div id="header"><StatusSelector value={state.value} pendingStatus={state.pendingStatus} pendingSince={state.pendingSince} onChange={next=>fixture.changes.push(next)}/></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
