import React from 'react';
export default function Link({href,children,...rest}){return React.createElement('a',{href:typeof href==='string'?href:'#',...rest},children);}
