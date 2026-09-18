import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeAttachmentMimeType, isAttachmentTypeAllowed } from "./attachment-types.mjs";

const fail=(message,status=400)=>Object.assign(new Error(message),{status});

// Stream admitted files to a private temporary directory. Only accepted files
// are loaded for BYTEA storage; multipart is never buffered whole.
async function withStreamedFiles(request,{maximumBytes,mimeTypes,maximumFiles=1,maximumTotalBytes=maximumBytes,message=false},consume) {
  const overhead=message?131072:65536;
  if(Number(request.headers.get("content-length"))>maximumTotalBytes+overhead)throw fail("Files are too large",413);
  if(!request.body)throw fail("File is required");
  let parser;
  try {
    parser=busboy({headers:{"content-type":request.headers.get("content-type")},defParamCharset:"utf8",
      limits:{files:maximumFiles,fields:1,parts:maximumFiles+2,fieldSize:message?100000:100,fileSize:maximumBytes+1}});
  } catch {throw fail("Invalid multipart upload");}
  const directory=await mkdtemp(join(tmpdir(),"cc-upload-"));
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60000),...(request.signal?[request.signal]:[])]);
  const writes=[];
  const files=[];let metadata,received=0,uploadError,parsing=true;
  const reject=error=>{uploadError ||= error;queueMicrotask(()=>controller.abort(error));};
  parser.on("file",(name,stream,info)=>{
    // Busboy also destroys rejected file streams when the body is aborted.
    // Consume their error event even though they never enter the disk pipeline.
    stream.on("error",reject);
    const type=normalizeAttachmentMimeType(info.mimeType,info.filename);
    if(name!=="file" || files.length>=maximumFiles || !isAttachmentTypeAllowed(type,info.filename,mimeTypes)) {
      stream.resume();reject(fail("This attachment type is disabled for the widget",403));return;
    }
    const path=join(directory,String(files.length));
    files.push({name:info.filename,type,arrayBuffer:()=>readFile(path),path});
    stream.on("limit",()=>reject(fail("File is too large",413)));
    writes.push(pipeline(stream,createWriteStream(path,{flags:"wx",mode:0o600}),{signal}).catch(reject));
  });
  parser.on("field",(name,value,info)=>{
    if(name!==(message?"message":"messageId") || metadata!==undefined || info.valueTruncated)reject(fail("Invalid attachment message metadata"));
    else metadata=value;
  });
  for(const event of ["filesLimit","fieldsLimit","partsLimit"])parser.on(event,()=>reject(fail("Too many multipart fields")));
  const limit=new Transform({transform(chunk,_encoding,callback){
    received+=chunk.length;
    callback(received>maximumTotalBytes+overhead?fail("Files are too large",413):null,chunk);
  }});
  try {
    await pipeline(Readable.fromWeb(request.body),limit,parser,{signal});
    await Promise.all(writes);
    if(uploadError)throw uploadError;
    if(!files.length || !metadata)throw fail("Files and message metadata are required");
    let total=0;
    for(const file of files){file.size=(await stat(file.path)).size;total+=file.size;if(file.size>maximumBytes)throw fail("File is too large",413);}
    if(total>maximumTotalBytes)throw fail("Files are too large",413);
    parsing=false;
    return await consume({files,metadata});
  } catch(error) {
    controller.abort(error);
    if(!parsing)throw error;
    throw uploadError || (signal.reason?.name==="TimeoutError"?fail("Upload timed out",408):error.status?error:fail("Upload was interrupted or malformed"));
  } finally {
    await Promise.all(writes);
    await rm(directory,{recursive:true,force:true});
  }
}

export const withStreamedAttachment=(request,policy,consume)=>withStreamedFiles(request,policy,({files,metadata})=>consume({file:files[0],clientId:metadata}));
export const withStreamedChatMessage=(request,policy,consume)=>withStreamedFiles(request,{...policy,message:true},consume);
