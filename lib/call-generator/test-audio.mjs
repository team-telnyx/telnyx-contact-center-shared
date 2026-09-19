// Deterministic, band-limited identities; no speech service or microphone needed.
export const MARKERS = Object.freeze({ A:[525,725], B:[925,1125], C1:[1325,1525], C2:[1725,1925], C3:[2125,2325] });
export const MARKER_PATTERN = [0,1,1,0,1,0,0,1,0,0,0,1];
export const MARKER_SLOT = 0.22;
// Loop only complete patterns; a partial final pattern creates false negatives
// in otherwise healthy audio windows that straddle the file boundary.
export const MARKER_LOOP_SECONDS = MARKER_SLOT * MARKER_PATTERN.length * 12;

export function markerSamples(marker,{sampleRate=16000,seconds=MARKER_LOOP_SECONDS}={}) {
  if(!Object.hasOwn(MARKERS,marker)) throw new Error('Unknown audio marker');
  const samples=new Float32Array(Math.round(sampleRate*seconds));
  for(let i=0;i<samples.length;i++) {
    const time=i/sampleRate,slot=Math.floor(time/MARKER_SLOT),phase=time%MARKER_SLOT;
    if(phase>=0.18) continue;
    const envelope=Math.min(1,phase/0.01,(0.18-phase)/0.01);
    samples[i]=0.28*envelope*Math.sin(2*Math.PI*MARKERS[marker][MARKER_PATTERN[slot%MARKER_PATTERN.length]]*time);
  }
  return samples;
}
export function encodeWav(samples,sampleRate=16000) {
  const out=Buffer.alloc(44+samples.length*2);
  out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);
  out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);
  out.writeUInt32LE(sampleRate,24);out.writeUInt32LE(sampleRate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
  out.write('data',36);out.writeUInt32LE(samples.length*2,40);
  for(let i=0;i<samples.length;i++)out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);
  return out;
}
export function decodeWav(input) {
  const b=Buffer.from(input);
  if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw new Error('Expected RIFF WAV recording');
  let format,channels,sampleRate,bits,data;
  for(let i=12;i+8<=b.length;) {
    const size=b.readUInt32LE(i+4),start=i+8;
    if(start+size>b.length)throw new Error('Truncated WAV');
    if(b.toString('ascii',i,i+4)==='fmt ') {format=b.readUInt16LE(start);channels=b.readUInt16LE(start+2);sampleRate=b.readUInt32LE(start+4);bits=b.readUInt16LE(start+14);}
    if(b.toString('ascii',i,i+4)==='data')data=b.subarray(start,start+size);
    i=start+size+(size%2);
  }
  if(!data || sampleRate<8000 || sampleRate>96000 || channels<1 || channels>2 || !((format===1&&bits===16)||(format===3&&bits===32)))throw new Error('Recording must be PCM16 or Float32 WAV');
  const count=Math.floor(data.length/(channels*bits/8));
  const tracks=Array.from({length:channels},()=>new Float32Array(count));
  for(let i=0;i<count;i++)for(let c=0;c<channels;c++) {
    const at=(i*channels+c)*bits/8;tracks[c][i]=format===1?data.readInt16LE(at)/32768:data.readFloatLE(at);
  }
  return {sampleRate,tracks};
}
function toneFraction(samples,start,n,frequency,sampleRate) {
  const coeff=2*Math.cos(2*Math.PI*frequency/sampleRate);let q0=0,q1=0,q2=0,energy=0;
  for(let i=start;i<start+n;i++){const value=samples[i]||0;q0=coeff*q1-q2+value;q2=q1;q1=q0;energy+=value*value;}
  return energy/n<1e-7?0:2*(q1*q1+q2*q2-coeff*q1*q2)/(n*energy);
}
export function detectMarker(samples,sampleRate,marker) {
  if(!Object.hasOwn(MARKERS,marker))throw new Error('Unknown marker');
  const slot=MARKER_SLOT,period=slot*MARKER_PATTERN.length,frame=Math.round(sampleRate*0.04);
  let best=0,at=null;
  for(let start=0;start+period<=samples.length/sampleRate;start+=0.04) {
    let hits=0;
    for(let i=0;i<MARKER_PATTERN.length;i++) {
      const offset=Math.round((start+i*slot+0.07)*sampleRate);
      if(toneFraction(samples,offset,frame,MARKERS[marker][MARKER_PATTERN[i]],sampleRate)>0.32)hits++;
    }
    if(hits>best){best=hits;at=start;}
    if(best===MARKER_PATTERN.length)break;
  }
  return {marker,detected:best>=11,matchedSlots:best,totalSlots:MARKER_PATTERN.length,atSeconds:at};
}
export function analyzeAudio(samples,sampleRate,{expected=[],absent=[]}={}) {
  const identities=[...new Set([...expected,...absent])].map(id=>detectMarker(samples,sampleRate,id));
  return {sampleRate,seconds:samples.length/sampleRate,identities,
    passed:(expected.length+absent.length)>0&&samples.length/sampleRate>=MARKER_SLOT*MARKER_PATTERN.length&&identities.every(result=>expected.includes(result.marker)?result.detected:!result.detected)};
}
