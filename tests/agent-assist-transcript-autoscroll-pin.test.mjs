import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reported live: clicking a filled slot jumps the Live Transcription panel to
// the exact bubble where it was captured, but if the customer/agent keep
// talking, the panel's unconditional auto-scroll-to-bottom effect yanks the
// view right back down to the newest message — the bubble the agent wanted
// to look at scrolls out of sight within a second or two.

test("auto-scroll to the newest message is suspended once the agent jumps to a specific bubble", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  // Pin/unpin state exists and gates the auto-scroll effect — it no longer
  // unconditionally scrolls to bottom on every transcriptions change.
  assert.match(source, /const \[isPinnedToBottom, setIsPinnedToBottom\] = useState\(true\)/);
  assert.match(source, /if \(isPinnedRef\.current\) \{\s*\n\s*scrollToBottom\(\);/);
  assert.doesNotMatch(source, /\/\/ Auto-scroll to bottom on new messages\s*\n\s*useEffect\(\(\) => \{\s*\n\s*endRef\.current\?\.scrollIntoView/);
});

test("jumping to a slot's source utterance unpins the panel so a later utterance doesn't scroll it away", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /if \(el\) setPinned\(false\);/);
});

test("new messages while unpinned are tallied instead of moving the view, and the panel re-pins near the bottom", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  // Unseen-message tally instead of scrolling while unpinned.
  assert.match(source, /setUnseenCount\(\(n\) => n \+ 1\)/);
  // Scroll-position listener re-pins when the agent scrolls back down
  // themselves (standard chat-UI resume-live behavior), not just via the button.
  assert.match(source, /const nearBottom = distanceFromBottom <= NEAR_BOTTOM_PX;/);
  assert.match(source, /if \(nearBottom !== isPinnedRef\.current\) setPinned\(nearBottom\);/);
});

test("a 'back to live' pill is rendered only while unpinned, and resumes auto-scroll on click", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /\{!isPinnedToBottom && \(/);
  assert.match(source, /onClick=\{handleResumeLive\}/);
  assert.match(
    source,
    /const handleResumeLive = useCallback\(\(\) => \{\s*\n\s*setPinned\(true\);\s*\n\s*scrollToBottom\(\);/
  );
});

// Reported live: sometimes the panel unpinned itself (showing the "back to
// live" pill) even though the agent never clicked a slot or touched the
// scrollbar. Root cause: our OWN scrollIntoView({behavior:"smooth"}) call
// animates the viewport over several frames, firing native "scroll" events
// throughout — and right at the start of that animation, scrollHeight has
// already grown for the new message but scrollTop hasn't animated to catch
// up yet, so distanceFromBottom transiently looks larger than
// NEAR_BOTTOM_PX. The scroll listener then misread that as the user
// manually scrolling away and unpinned on its own.
test("the scroll listener ignores scroll events triggered by our own programmatic scrollIntoView, not just genuine user scrolls", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  // A ref flag distinguishes our own scroll calls from user-initiated ones.
  assert.match(source, /const isProgrammaticScrollRef = useRef\(false\);/);
  // scrollToBottom sets the flag before scrolling and clears it on a timer.
  assert.match(
    source,
    /const scrollToBottom = useCallback\(\(behavior = "smooth"\) => \{\s*\n\s*isProgrammaticScrollRef\.current = true;/
  );
  assert.match(
    source,
    /programmaticScrollTimeoutRef\.current = setTimeout\(\(\) => \{\s*\n\s*isProgrammaticScrollRef\.current = false;/
  );
  // The scroll listener bails out early while a programmatic scroll is in
  // flight, BEFORE computing distanceFromBottom/nearBottom.
  assert.match(
    source,
    /const handleScroll = \(\) => \{\s*\n(?:\s*\/\/.*\n)*\s*if \(isProgrammaticScrollRef\.current\) return;\s*\n\s*const distanceFromBottom/
  );
  // The explicit jump-to-slot scroll also sets the guard, so a handleScroll
  // firing mid-jump-animation can't re-pin before the jump's own explicit
  // setPinned(false) runs.
  const jumpEffectStart = source.indexOf("// Jump to (and highlight) the transcript bubble");
  const jumpEffectSection = source.slice(jumpEffectStart, jumpEffectStart + 800);
  assert.match(jumpEffectSection, /isProgrammaticScrollRef\.current = true;/);
});

// Codex review: while isProgrammaticScrollRef is true (up to 500ms after
// EVERY auto-scroll-on-new-message), handleScroll ignores ALL scroll
// events — including a genuine user wheel/trackpad scroll that happens to
// land in that same window. Without a re-check, isPinnedRef would then
// incorrectly stay "pinned" even though the user just scrolled away, so the
// NEXT transcription would yank the view back to the bottom instead of
// showing the unseen-message pill.
test("scrollToBottom re-checks the actual scroll position once its programmatic guard clears, catching a user scroll that happened during the window", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  // NEAR_BOTTOM_PX is hoisted to module scope so both the re-check and the
  // scroll listener use the exact same threshold.
  assert.match(source, /^const NEAR_BOTTOM_PX = 48;/m);

  const scrollToBottomStart = source.indexOf('const scrollToBottom = useCallback((behavior = "smooth")');
  const scrollToBottomSection = source.slice(scrollToBottomStart, scrollToBottomStart + 2200);
  assert.match(scrollToBottomSection, /isProgrammaticScrollRef\.current = false;\s*\n\s*programmaticScrollTimeoutRef\.current = null;/);
  assert.match(scrollToBottomSection, /const viewport = findScrollViewport\(endRef\.current\);/);
  assert.match(scrollToBottomSection, /const distanceFromBottom = viewport\.scrollHeight - viewport\.scrollTop - viewport\.clientHeight;/);
  assert.match(scrollToBottomSection, /const nearBottom = distanceFromBottom <= NEAR_BOTTOM_PX;/);
  assert.match(scrollToBottomSection, /if \(nearBottom !== isPinnedRef\.current\) setPinned\(nearBottom\);/);
  // setPinned is now a dependency of the scrollToBottom callback (it's
  // called from inside the timeout), not an empty deps array.
  assert.match(scrollToBottomSection, /\}, \[setPinned\]\);/);
});
