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
