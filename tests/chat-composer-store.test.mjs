import test from "node:test";
import assert from "node:assert/strict";
import { createChatComposerStore } from "../components/contact-center/chat-composer-store.js";

test("ending or transferring a chat releases its files without disturbing other replies",()=>{
  const store=createChatComposerStore(),file=new File(["draft"],"draft.txt");
  store.retain(["active","transferred"]);
  store.update("active",{files:[{id:"active-file",file}]});
  store.update("transferred",{files:[{id:"old-file",file}],error:"Send failed",lastSent:{commandId:"old"}});
  const active=store.get("active");let notified=0;const unsubscribe=store.subscribe(()=>notified++);
  store.retain(["active"]);
  assert.deepEqual(store.get("transferred").files,[]);
  assert.equal(store.get("transferred").lastSent,null);
  assert.equal(store.get("transferred").error,"");
  assert.equal(store.get("active"),active);
  assert.equal(notified,1);
  store.retain(["active"]);assert.equal(notified,1);unsubscribe();
});

test("a late send response cannot restore files or results for an interaction that left the desktop",async()=>{
  const store=createChatComposerStore();store.retain(["chat"]);
  const files=[{id:"file",file:new File(["draft"],"draft.txt")}];
  store.update("chat",{files,sending:true,pending:{files,message:{commandId:"send"}}});
  let finish;const reply=new Promise(resolve=>{finish=resolve;}).then(()=>{
    store.update("chat",{files,pending:{files},error:"Network unavailable"});
    store.update("chat",{lastSent:{commandId:"send"},sending:false});
  });
  store.retain([]);finish();await reply;
  assert.deepEqual(store.get("chat"),{files:[],pending:null,sending:false,error:"",lastSent:null});
  store.retain(["chat"]);
  assert.deepEqual(store.get("chat").files,[]);
  store.update("chat",{files});assert.equal(store.get("chat").files,files);
});

// Browser sessionStorage survives sign-out/sign-in within the same tab.
import { readScopedDraftCache } from "../lib/contact-center/chat-draft-cache.mjs";
function draftStorage(value) {
  const data=new Map([["draft",JSON.stringify(value)]]);
  return {getItem:key=>data.get(key)??null,removeItem:key=>data.delete(key)};
}
test("reload recovers unsent text from the same authenticated draft scope",()=>{
  const draft={body:"Unsent reply",version:"3",scope:"session-a"};
  assert.deepEqual(readScopedDraftCache(draftStorage(draft),"draft","session-a"),draft);
});
test("a new login cannot import or autosave text left by the previous session",()=>{
  const storage=draftStorage({body:"Previous login reply",version:"3",scope:"session-a"});
  assert.equal(readScopedDraftCache(storage,"draft","session-b"),null);
  assert.equal(storage.getItem("draft"),null);
});
test("unscoped drafts recover only against a legacy backend",()=>{
  const draft={body:"Legacy unsent reply",version:"2"};
  assert.deepEqual(readScopedDraftCache(draftStorage(draft),"draft"),draft);
  assert.equal(readScopedDraftCache(draftStorage(draft),"draft","session-a"),null);
});
test("unavailable or invalid browser storage does not prevent loading server drafts",()=>{
  assert.equal(readScopedDraftCache({getItem(){throw Error("disabled");}},"draft"),null);
  assert.equal(readScopedDraftCache({getItem:()=>"invalid json"},"draft"),null);
  assert.equal(readScopedDraftCache(draftStorage({body:42}),"draft"),null);
});
