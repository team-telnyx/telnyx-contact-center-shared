import { record } from "@rrweb/record";
import { Replayer } from "@rrweb/replay";

window.verifyMirrorTarget = async () => {
  const events = [];
  let sourceMirror;
  const stop = record({
    emit: (event) => events.push(event),
    plugins: [{ name: "cobrowse-control-mirror-test", options: {},
      getMirror: ({ nodeMirror }) => { sourceMirror = nodeMirror; } }],
    maskAllInputs: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sourceNodeId = sourceMirror?.getId(document.getElementById("safe-target"));
  stop();
  const replayer = new Replayer([], { root: document.getElementById("replay-root"), liveMode: true,
    useVirtualDom: false, triggerFocus: false, showWarning: false });
  replayer.startLive(Date.now() + 86_400_000);
  for (const event of events) replayer.addEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const replayDocument = replayer.iframe?.contentDocument;
  const replayTarget = replayDocument?.getElementById("safe-target");
  const replayNodeId = replayTarget && replayer.getMirror().getId(replayTarget);
  const rect = replayTarget?.getBoundingClientRect();
  const hitTarget = rect && replayDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const hitNodeId = hitTarget && replayer.getMirror().getId(hitTarget);
  const result = { sourceNodeId, replayNodeId, hitNodeId, sandbox: replayer.iframe?.getAttribute("sandbox") };
  replayer.destroy();
  return result;
};
