import React from 'react';
export default function Image({src,alt='',...rest}){return React.createElement('img',{src:typeof src==='string'?src:src?.src,alt,...rest});}
