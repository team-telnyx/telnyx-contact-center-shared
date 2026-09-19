import {test} from "node:test";
import assert from "node:assert/strict";
import {attachmentResponse} from "../lib/widgets/attachments.js";

const file={content_type:"audio/mpeg",name:"sample.mp3",bytes:Buffer.from("0123456789"),byte_size:10};
for(const [range,expected,start,end] of [["bytes=0-1","01",0,1],["bytes=3-","3456789",3,9],["bytes=-3","789",7,9],["bytes=8-99","89",8,9]]){
  test(`audio range ${range} has a single Content-Length matching the body`,async()=>{
    const response=attachmentResponse(new Request("https://test.local/audio",{headers:{Range:range}}),file);
    assert.equal(response.status,206);
    assert.equal(response.headers.get("content-length"),String(expected.length));
    assert.equal(response.headers.get("content-range"),`bytes ${start}-${end}/10`);
    assert.equal(response.headers.get("content-type"),"audio/mpeg");
    assert.equal(response.headers.get("accept-ranges"),"bytes");
    assert.match(response.headers.get("cache-control"),/no-store/);
    assert.equal(await response.text(),expected);
  });
}
test("full audio response and unsatisfiable ranges keep correct HTTP semantics",async()=>{
  const response=attachmentResponse(new Request("https://test.local/audio"),file);
  assert.equal(response.status,200);assert.equal(response.headers.get("content-length"),"10");
  assert.equal(await response.text(),"0123456789");
  for(const range of ["bytes=10-","bytes=5-2","bytes=-0"]){
    const invalid=attachmentResponse(new Request("https://test.local/audio",{headers:{Range:range}}),file);
    assert.equal(invalid.status,416);assert.equal(invalid.headers.get("content-range"),"bytes */10");
    assert.equal(await invalid.text(),"");
  }
});
