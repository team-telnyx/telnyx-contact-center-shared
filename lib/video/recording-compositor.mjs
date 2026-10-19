// Bounded fallback for provider compositions that fail or remain queued.
// Raw files and the output are private; only the permission-checked recording
// endpoint serves the result. No shell interpolation and no URLs reach FFmpeg.
import {mkdtemp,open,copyFile,chmod,mkdir,rename,rm,stat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {defaultRoomsClient} from './rooms.mjs';
import {persistVideoArtifact} from './lifecycle.mjs';
import {parseAttachmentByteRange} from '../widgets/attachment-ranges.js';
const INPUT_LIMIT=1024*1024*1024, OUTPUT_LIMIT=512*1024*1024;
// Recordings are runtime data on private storage, never build-time assets.
// Keep Turbopack from tracing this configurable directory (or the whole project).
const directory=()=>process.env.CC_VIDEO_RECORDING_DIR||path.join(/* turbopackIgnore: true */ process.cwd(),'.data','video-recordings');
function filePath(key){if(!/^[a-f0-9-]{36}\.mp4$/.test(key))throw Error('Invalid recording key');return path.join(directory(),key);}
function run(binary,args,timeout=900000,signal){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{stdio:['ignore','pipe','pipe'],signal,killSignal:'SIGKILL'});let output='',errors='';
 const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Recording composition timed out'));},timeout);
 child.stdout.on('data',b=>{if(output.length<1000000)output+=b.toString();});child.stderr.on('data',b=>{errors=(errors+b).slice(-6000);});
 child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`Recording compositor exited ${code}: ${errors.slice(-1200)}`));});
});}
export async function readPrivateVideoRecording(metadata,rangeHeader){
 const filename=filePath(metadata.storage_key),info=await stat(/* turbopackIgnore: true */ filename);const range=rangeHeader?parseAttachmentByteRange(rangeHeader,info.size):null;
 if(rangeHeader&&!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
 const start=range?.start||0,end=range?.end??info.size-1;
 return new Response(Readable.toWeb(createReadStream(/* turbopackIgnore: true */ filename,{start,end})),{status:range?206:200,headers:{'Content-Type':'video/mp4','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...(range?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{})}});
}
export async function composeVideoRecording(pool,session,{rooms=defaultRoomsClient(),ffmpeg=process.env.VIDEO_AI_FFMPEG_PATH||'ffmpeg',ffprobe=process.env.VIDEO_AI_FFPROBE_PATH||'ffprobe',signal}={}){
 const lock=await pool.connect();let locked=false,folder,stored;
 try{
  locked=(await lock.query('SELECT pg_try_advisory_lock(814025,3) AS ok')).rows[0].ok;if(!locked)return {busy:true};
  const fresh=(await lock.query('SELECT * FROM acd_video_sessions WHERE id=$1',[session.id])).rows[0];
  if(fresh.composition_state==='completed_local')return {id:fresh.composition_id,alreadyCompleted:true};
  session=fresh;
  const listed=await rooms.listRecordings({sessionId:session.room_session_id});
  if(!listed.length||listed.some(r=>r.status!=='completed'))throw Error('Source recordings are not complete');
  if(listed.length>32)throw Error('Recording exceeds the 32-source composition limit; raw sources are retained');
  await lock.query("UPDATE acd_video_sessions SET composition_state='composing_local',composition_local_attempts=composition_local_attempts+1,updated_at=now() WHERE id=$1",[session.id]);
  folder=await mkdtemp(path.join(tmpdir(),'cc-video-recording-'));let total=0;
  const inputs=[],skipped=[];
  for(const item of listed){
   signal?.throwIfAborted();
   const detail=await rooms.getRecording(item.id);
   // size_mb is rounded to whole MiB, including zero for valid short audio.
   if(!detail.started_at&&!detail.codec&&detail.duration_secs===0){skipped.push({id:item.id,reason:'empty provider recording'});continue;}
   if(!detail.download_url)throw Error('A completed recording has no download URL');
   const url=new URL(detail.download_url);if(url.protocol!=='https:')throw Error('Recording download requires HTTPS');
   const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});if(!response.ok)throw Error(`Recording download failed (${response.status})`);
   const filename=path.join(folder,`${inputs.length}.media`),file=await open(filename,'wx',0o600);
   try{for await(const chunk of response.body){total+=chunk.length;if(total>INPUT_LIMIT)throw Error('Recording inputs exceed 1 GiB');await file.write(chunk);}}finally{await file.close();}
   const probe=JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',filename],30000,signal));
   const stream=probe.streams.find(s=>s.codec_type===item.type);if(!stream)throw Error('A provider recording contains no declared media track');
   const start=Date.parse(detail.started_at);if(!Number.isFinite(start))throw Error('Recording has no alignment timestamp');
   inputs.push({...detail,file:filename,index:inputs.length,start,duration:Number(probe.format.duration)||detail.duration_secs});
  }
  const videos=inputs.filter(r=>r.type==='video'),audios=inputs.filter(r=>r.type==='audio');
  if(!videos.length)throw Error('No video source is available for composition');
  const start=Math.min(...inputs.map(r=>r.start)),duration=Math.max(...inputs.map(r=>(r.start-start)/1000+r.duration));
  if(duration>7200)throw Error('Recording exceeds the two-hour composition limit; raw sources are retained');
  const identities=[...new Set(videos.map(r=>`${r.participant_id}:${r.key||'self'}`))];
  if(identities.length>12)throw Error('Recording exceeds the 12-tile composition limit; raw sources are retained');
  const columns=Math.min(3,identities.length),rows=Math.ceil(identities.length/columns),width=Math.floor(1280/columns/2)*2,height=Math.floor(720/rows/2)*2;
  const filters=[`color=c=black:s=1280x720:r=20:d=${duration.toFixed(3)}[base0]`];
  videos.forEach((r,n)=>{const tile=identities.indexOf(`${r.participant_id}:${r.key||'self'}`),offset=(r.start-start)/1000;
   filters.push(`[${r.index}:v]setpts=PTS-STARTPTS+${offset.toFixed(6)}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${n}]`);
   filters.push(`[base${n}][v${n}]overlay=x=${(tile%columns)*width}:y=${Math.floor(tile/columns)*height}:eof_action=pass:repeatlast=0:enable='between(t,${offset.toFixed(3)},${(offset+r.duration).toFixed(3)})'[base${n+1}]`);
  });
  audios.forEach((r,n)=>filters.push(`[${r.index}:a]asetpts=PTS-STARTPTS,adelay=${Math.max(0,Math.round(r.start-start))}:all=1[a${n}]`));
  if(audios.length)filters.push(`${audios.map((_,n)=>`[a${n}]`).join('')}amix=inputs=${audios.length}:duration=longest:normalize=0,alimiter=limit=0.95[audio]`);
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1',...inputs.flatMap(r=>['-threads','1','-i',r.file]),'-filter_complex',filters.join(';'),'-map',`[base${videos.length}]`,...(audios.length?['-map','[audio]','-c:a','aac','-b:a','96k']:[]),'-c:v','libx264','-preset','veryfast','-crf','25','-threads','2','-pix_fmt','yuv420p','-t',duration.toFixed(3),'-movflags','+faststart','-fs',String(OUTPUT_LIMIT),path.join(folder,'result.mp4')];
  await run(ffmpeg,args,900000,signal);
  const composed=JSON.parse(await run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',path.join(folder,'result.mp4')],30000,signal));
  if(Number(composed.format.duration)<duration-1||Number(composed.format.size)>=OUTPUT_LIMIT)throw Error('Composition was truncated by its resource limit');
  const id=randomUUID(),key=`${id}.mp4`;await mkdir(directory(),{recursive:true,mode:0o700});
  stored=filePath(key);await copyFile(path.join(folder,'result.mp4'),stored+'.tmp');await chmod(stored+'.tmp',0o600);await rename(stored+'.tmp',stored);
  const metadata={storage_key:key,byte_size:Number(composed.format.size),duration_secs:Number(composed.format.duration),engine:'ffmpeg',sources:inputs.map(({id,participant_id,key,type,start,duration})=>({id,participant_id,key,type,start,duration})),skipped,provider_composition_id:session.composition_id};
  await lock.query('BEGIN');
  await persistVideoArtifact(lock,{session,providerRecordingId:id,kind:'composition',format:'mp4',sourceEventId:`video-local-composition:${session.id}`,startedAt:new Date(start).toISOString(),endedAt:new Date(start+duration*1000).toISOString(),metadata});
  await lock.query("UPDATE acd_video_sessions SET composition_id=$2,composition_state='completed_local',composition_error=NULL,updated_at=now() WHERE id=$1",[session.id,id]);await lock.query('COMMIT');stored=null;
  return {id,...metadata};
 }catch(error){await lock.query('ROLLBACK').catch(()=>undefined);if(locked)await lock.query("UPDATE acd_video_sessions SET composition_state='failed',composition_local_attempts=GREATEST(0,composition_local_attempts-$3),composition_error=$2,updated_at=now() WHERE id=$1",[session.id,signal?.aborted?'Composition interrupted by worker shutdown':String(error.message).slice(0,500),signal?.aborted?1:0]);throw error;}
 finally{if(folder)await rm(folder,{recursive:true,force:true});if(stored){await rm(stored,{force:true});await rm(stored+'.tmp',{force:true});}try{if(locked)await lock.query('SELECT pg_advisory_unlock(814025,3)');}finally{lock.release();}}
}

// Retain referenced recordings according to their existing database lifecycle.
// Remove only files orphaned by a crash or deleted metadata, after a full day.
export async function pruneOrphanVideoRecordings(pool) {
  const entries=await readdir(/* turbopackIgnore: true */ directory()).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const name of entries.filter(n=>/^[a-f0-9-]{36}\.mp4(?:\.tmp)?$/.test(n)).slice(0,500)) {
    const file=path.join(directory(),name),info=await stat(/* turbopackIgnore: true */ file).catch(()=>null);
    if(!info||Date.now()-info.mtimeMs<86400000)continue;
    const referenced=await pool.query(`SELECT 1 FROM acd_recordings WHERE provider='telnyx_video' AND provider_metadata->>'storage_key'=$1
      UNION ALL SELECT 1 FROM acd_video_sessions v WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v.artifacts) a WHERE a->'metadata'->>'storage_key'=$1) LIMIT 1`,[name]);
    if(!referenced.rowCount)await rm(file,{force:true});
  }
}
