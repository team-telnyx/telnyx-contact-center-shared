import './process-shim.js';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import InteractionSla from '../../components/contact-center/InteractionSla';
import {useAnalyticsQueueOptions} from '../../components/contact-center/useAnalyticsQueueOptions';

const fixture=window.fixture={requests:[],mode:'success',scope:'from=2026-09-08T00%3A00%3A00Z&to=2026-09-14T23%3A59%3A59Z&timezone=Europe%2FWarsaw&channel=email&report=transfers-holds&queue=Yesterday',pending:[]};
window.fetch=async(url,{signal})=>{
  fixture.requests.push(url);
  if(fixture.mode==='defer')return new Promise(resolve=>fixture.pending.push(resolve));
  return {ok:fixture.mode!=='error',json:async()=>({queues:fixture.mode==='empty'?[]:['Yesterday','Skills only','Active handoff']})};
};
function App(){
  const [kind,setKind]=useState('none'),[query,setQuery]=useState(fixture.scope),[refresh,setRefresh]=useState(0);
  const [deadline,setDeadline]=useState(Date.now()+30000);
  fixture.setKind=setKind;fixture.setQuery=setQuery;fixture.refresh=()=>setRefresh(n=>n+1);fixture.setDeadline=setDeadline;
  const options=useAnalyticsQueueOptions(refresh);
  const sla={state:'pending',deadline_at:new Date(deadline).toISOString(),policy:{thresholdSeconds:10,warningPercentage:80}};
  return <><pre id="options">{JSON.stringify(options)}</pre><div id="badges">{Array.from({length:1000},(_,i)=><InteractionSla key={i} sla={kind==='none'?null:sla} {...(kind==='external'?{now:deadline-1000}:{})}/>)}</div></>;
}
createRoot(document.getElementById('root')).render(<App/>);
