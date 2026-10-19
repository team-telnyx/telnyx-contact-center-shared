// The provider must not greet until the room recipients can play its stream.
export async function waitForRoomPlayback({ publish, participants, send, received, stopped = () => false, timeoutMs = 15000, joinTimeoutMs = 45000 }) {
  await publish();
  const nonce = crypto.randomUUID();
  // AI-first starts the worker before the browser receives its room token.
  // Keep room admission separate from playback readiness, within the worker's
  // 85-second startup guard and the avatar client's 70-second setup guard.
  const joinDeadline = Date.now() + joinTimeoutMs;
  let playbackDeadline = null;
  while (!stopped()) {
    const expected = participants();
    if (expected.length && playbackDeadline === null) playbackDeadline = Date.now() + timeoutMs;
    if (Date.now() >= (playbackDeadline ?? joinDeadline)) break;
    if (expected.length) {
      if (expected.every(id => received.get(id) === nonce)) return;
      await send({ type: "ai.media.probe", nonce }, expected);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Conference audio playback was not ready. Rejoin the video call and allow audio playback.");
}
