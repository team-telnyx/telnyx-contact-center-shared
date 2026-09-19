// Build and serve the real dialer component against synthetic HTTP/auth boundaries.
// No sessions, credentials, live API calls or browser-driving library are used.
// Run: node tests/browser/rbac-dialer-fixture-server.cjs
// Open http://127.0.0.1:3102/?section=contact-lists&action=read (or update/create/import).
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),assert=require('node:assert/strict');
const output=process.env.RBAC_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-rbac-ui-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(root,'tests/browser','rbac-dialer.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},resolveExtensions:['.tsx','.ts','.jsx','.js','.mjs','.json','.css'],
    alias:{'@/components/auth-provider':path.join(root,'tests/browser/shims/authz-fixture.jsx'),'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom'),'next/navigation':path.join(root,'tests/browser','shims/next-navigation.js'),'next/link':path.join(root,'tests/browser','shims/next-link.js'),'next/image':path.join(root,'tests/browser','shims/next-image.js'),'next/dynamic':path.join(root,'tests/browser','shims/next-dynamic.js')},
    define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/')||args.path.startsWith('next/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
  const css=await postcss([tailwind({base:root})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
  fs.writeFileSync(path.join(output,'app.css'),css.css);
  fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}

(async()=>{await build();const server=http.createServer((request,response)=>{const pathname=new URL(request.url,'http://127.0.0.1').pathname;const file={'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[pathname];if(!file){response.writeHead(404).end();return;}response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(fs.readFileSync(path.join(output,file)));});server.listen(Number(process.env.RBAC_UI_PORT || 3102),'127.0.0.1',()=>console.log('Synthetic UI fixture ready on 127.0.0.1:3102'));})().catch(e=>{console.error(e);process.exitCode=1});
