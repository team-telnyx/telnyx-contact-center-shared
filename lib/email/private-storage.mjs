import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emailError } from './provider.mjs';

// Email content is never placed in public/media or exposed as a bucket URL.
// Production can use the existing S3 account with a separate private prefix.
let s3;
async function s3Context() {
  if(!s3)s3=(async()=>{
    const sdk=await import('@aws-sdk/client-s3');
    const accessKeyId=process.env.STORAGE_ACCESS_KEY,secretAccessKey=process.env.STORAGE_SECRET_KEY;
    return {sdk,client:new sdk.S3Client({region:process.env.STORAGE_REGION||process.env.AWS_REGION||'us-east-1',endpoint:process.env.STORAGE_ENDPOINT||undefined,
      forcePathStyle:process.env.STORAGE_FORCE_PATH_STYLE==='true',...(accessKeyId&&secretAccessKey?{credentials:{accessKeyId,secretAccessKey}}:{})})};
  })();return s3;
}
function location(key){
  if(!/^[a-f0-9]{64}$/.test(key))throw emailError('Invalid stored email attachment',404);
  const bucket=process.env.CC_EMAIL_STORAGE_BUCKET || (process.env.STORAGE_PROVIDER==='s3'?process.env.STORAGE_BUCKET:null);
  const prefix=String(process.env.CC_EMAIL_STORAGE_PREFIX||`${process.env.STORAGE_PREFIX||'contact-center'}/email-private`).replace(/^\/+|\/+$/g,'');
  // Attachments are retained at runtime, not source assets to trace into a build.
  return {bucket,key:`${prefix}/${key}`,file:path.join(/* turbopackIgnore: true */ process.env.CC_EMAIL_STORAGE_DIR||path.join(process.cwd(),'.data','email'),key)};
}
export async function retainEmailFile(bytes) {
  if(bytes.length>25_000_000)throw emailError('Email attachment exceeds 25 MB',413);
  const key=createHash('sha256').update(bytes).digest('hex'),target=location(key);
  if(target.bucket){const {client,sdk}=await s3Context();await client.send(new sdk.PutObjectCommand({Bucket:target.bucket,Key:target.key,Body:bytes,ContentType:'application/octet-stream',CacheControl:'private, no-store'}));}
  else {await mkdir(path.dirname(target.file),{recursive:true,mode:0o700});await writeFile(target.file,bytes,{mode:0o600});}
  return {storage_key:key,size_bytes:bytes.length,sha256:key};
}
export async function readEmailFile(key){
  const target=location(key);
  if(!target.bucket)return readFile(/* turbopackIgnore: true */ target.file);
  const {client,sdk}=await s3Context(),result=await client.send(new sdk.GetObjectCommand({Bucket:target.bucket,Key:target.key}));
  const parts=[];let total=0;
  for await(const part of result.Body){total+=part.length;if(total>25_000_000)throw emailError('Stored attachment exceeds the size limit',413);parts.push(Buffer.from(part));}
  return Buffer.concat(parts);
}
