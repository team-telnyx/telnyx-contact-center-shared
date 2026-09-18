import React,{useEffect,useState} from 'react';
export default function dynamic(loader){return function Dynamic(props){const [Component,setComponent]=useState(null);useEffect(()=>{Promise.resolve(loader()).then(m=>setComponent(()=>m.default||m));},[]);return Component?React.createElement(Component,props):null;};}
