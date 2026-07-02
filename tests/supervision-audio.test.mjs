import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("supervisor dial endpoint uses Telnyx supervised-call payload documented for /calls", async () => {
  const routeSource = await readFile(new URL("../app/api/contact-center/calls/supervise/route.js", import.meta.url), "utf8");
  const openApi = JSON.parse(await readFile(new URL("../openapi/telnyx.json", import.meta.url), "utf8"));
  const callRequest = openApi.components.schemas.CallRequest;
  assert.ok(callRequest.properties.supervise_call_control_id, "Telnyx /calls request supports supervise_call_control_id");
  assert.ok(callRequest.properties.supervisor_role, "Telnyx /calls request supports supervisor_role");
  assert.match(routeSource, /supervise_call_control_id,/, "endpoint should send supervised leg call_control_id to /calls");
  assert.match(routeSource, /supervisor_role: role/, "endpoint should send monitor/whisper/barge role to /calls");
  assert.match(routeSource, /to: supervisorSipUri/, "endpoint should dial the supervisor WebRTC SIP endpoint");
  assert.match(routeSource, /from: fromNumber/, "endpoint should include caller ID for the supervisor leg");
});

test("supervision modal attaches answered supervisor WebRTC media to a real audio element", async () => {
  const source = await readFile(new URL("../components/contact-center/SupervisionModal.jsx", import.meta.url), "utf8");
  assert.match(source, /supervisorRemoteAudioRef = useRef\(null\)/, "modal should own a hidden audio element ref");
  assert.match(source, /<audio ref=\{supervisorRemoteAudioRef\} autoPlay playsInline className="hidden" \/>/, "modal should render the audio element");
  assert.match(source, /setAudioElement\(audioEl\)/, "modal should bind Telnyx WebRTC call media to the audio element");
  assert.match(source, /remoteStream \|\| supervisorCall\.remoteMediaStream \|\| supervisorCall\.stream/, "modal should fallback to SDK remote media streams");
  assert.match(source, /Promise\.resolve\(activeCall\.answer\?\.\(\)\)/, "answer flow should wait for Telnyx answer before hydrating audio");
});
