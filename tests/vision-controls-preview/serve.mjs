import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import sharp from 'sharp';
const root=process.cwd();
const bundle=await build({entryPoints:['tests/vision-controls-preview/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'},loader:{'.js':'jsx'}});
const css=(await postcss([tailwindcss()]).process(await fs.readFile('app/globals.css','utf8'),{from:path.join(root,'app/globals.css')})).css;
const portrait=await fs.readFile('public/images/avatars/telnyx/elena.png');
const sample='<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#d5f4ed"/><rect x="25" y="30" width="75" height="75" rx="6" fill="#009a79"/><circle cx="166" cy="70" r="33" fill="#fb7185"/><text x="28" y="140" fill="#24394a" font-size="22" font-family="sans-serif">VISION 4178</text></svg>';
const samplePng=await sharp(Buffer.from(sample)).png().toBuffer();
http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}
 else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);}
 else if(req.url==='/elena.png'){res.setHeader('Content-Type','image/png');res.end(portrait);}
 else if(req.url==='/sample.png'){res.setHeader('Content-Type','image/png');res.end(samplePng);}
 else if(req.url.startsWith('/api/')){res.statusCode=404;res.end('No APIs in this preview');}
 else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vision controls — UI preview</title><link rel="stylesheet" href="/app.css"></head><body style="background:#f4f6f8;font-family:Arial,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>');}
}).listen(3005,'127.0.0.1',()=>console.log('Vision UI preview: http://127.0.0.1:3005'));
