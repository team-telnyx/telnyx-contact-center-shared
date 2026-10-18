// G.711 µ-law is unambiguous on Telnyx media streams (mono / 8 kHz).
// Watch continues to capture PCM16LE / 16 kHz and play PCM16LE / 24 kHz.
export function encodeMuLaw(sample) {
  const sign=sample<0?0x80:0;
  let value=Math.min(Math.abs(sample),32635)+132, exponent=7;
  for(let mask=0x4000;exponent>0 && !(value&mask);mask>>=1) exponent--;
  return (~(sign | exponent<<4 | (value>>(exponent+3)&15)))&255;
}
export function decodeMuLaw(byte) {
  const value=(~byte)&255;
  const sample=(((value&15)<<3)+132) << ((value>>4)&7);
  return (value&128) ? 132-sample : sample-132;
}
export function createVoiceCodec() {
  let previous=0, pending=Buffer.alloc(0);
  return {
    encode(pcm) {
      pending=Buffer.concat([pending,pcm]);
      const count=Math.floor(pending.length/4), output=Buffer.alloc(count);
      for(let i=0;i<count;i++) output[i]=encodeMuLaw(Math.round((pending.readInt16LE(i*4)+pending.readInt16LE(i*4+2))/2));
      pending=pending.subarray(count*4); return output;
    },
    decode(bytes) {
      const pcm=Buffer.alloc(bytes.length*6);
      for(let i=0;i<bytes.length;i++) {
        const sample=decodeMuLaw(bytes[i]);
        for(let j=0;j<3;j++) pcm.writeInt16LE(Math.round(previous+(sample-previous)*(j+1)/3),i*6+j*2);
        previous=sample;
      }
      return pcm;
    }
  };
}
