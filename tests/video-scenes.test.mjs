import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIDEO_SCENE, MAX_VISIBLE_TILES, VIDEO_SCENES, focusTile, orderTiles, planScene, sceneAspect } from "../lib/video/scenes.mjs";

const A = 4 / 3;
const cam = (id, role, self = false) => ({ id, role, kind: "camera", self });
const screen = (id, role) => ({ id, role, kind: "screen", self: false });
const customer = cam("cust", "customer"), agent = cam("agent", "agent"), supervisor = cam("sup", "supervisor"), me = cam("self", "customer", true);
const ratio = (rect) => rect.w / rect.h;
const within = (plan, box) => plan.width <= box.width + 1 && plan.height <= box.height + 1 && plan.rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= plan.width + 1 && r.y + r.h <= plan.height + 1);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const disjoint = (rects) => rects.every((a, i) => rects.every((b, j) => i === j || a.kind === "thumb" || b.kind === "thumb" || !overlaps(a, b)));

test("the focus tile is the shared screen, then the counterpart of the viewer's role, then self", () => {
  assert.equal(focusTile([me, agent], "customer").id, "agent");
  assert.equal(focusTile([cam("self", "agent", true), customer, supervisor], "agent").id, "cust");
  assert.equal(focusTile([cam("self", "supervisor", true), agent, customer], "supervisor").id, "cust");
  assert.equal(focusTile([me, agent, screen("agent:screen", "agent")], "customer").id, "agent:screen");
  assert.equal(focusTile([me], "customer").id, "self");
  assert.equal(focusTile([me, { id: "self:screen", role: "customer", kind: "screen", self: true }, agent], "customer").id, "self:screen", "the sharer sees their own screen as the main frame too");
  assert.deepEqual(orderTiles([me, supervisor, agent], "customer").map((t) => t.id), ["agent", "sup", "self"]);
  assert.equal(orderTiles([me, agent, supervisor, screen("s", "agent"), cam("x", "agent")], "customer").length, MAX_VISIBLE_TILES);
  assert.deepEqual(VIDEO_SCENES, ["remote", "split", "pip", "spotlight"]); assert.equal(DEFAULT_VIDEO_SCENE, "pip");
});

test("a lone participant is one 4:3 frame regardless of the scene; remote hides self", () => {
  for (const scene of VIDEO_SCENES) {
    const plan = planScene({ scene, tiles: [me], viewerRole: "customer", box: { width: 352, height: 600 }, orientation: "column" });
    assert.equal(plan.scene, "remote"); assert.equal(plan.rects.length, 1);
    assert.deepEqual([plan.rects[0].w, plan.rects[0].h], [352, 264]);
  }
  const remote = planScene({ scene: "remote", tiles: [me, agent], viewerRole: "customer", box: { width: 352, height: 600 } });
  assert.deepEqual(remote.rects.map((r) => r.id), ["agent"]); assert.deepEqual(remote.hidden, ["self"]);
});

test("picture in picture keeps the thumbnails inside the main frame, self in the corner", () => {
  const plan = planScene({ scene: "pip", tiles: [me, agent, supervisor], viewerRole: "customer", box: { width: 352, height: 600 } });
  const [main, ...thumbs] = plan.rects;
  assert.equal(main.id, "agent"); assert.deepEqual([main.w, main.h], [352, 264]);
  assert.equal(thumbs.length, 2);
  const self = thumbs.find((t) => t.id === "self"), sup = thumbs.find((t) => t.id === "sup");
  assert.ok(self.x > sup.x, "self preview is the right-most thumbnail");
  for (const t of thumbs) { assert.ok(t.x >= 0 && t.x + t.w <= main.w && t.y + t.h <= main.h, "thumbnail inside the main frame"); assert.ok(Math.abs(ratio(t) - A) < 0.03); }
  assert.equal(self.x + self.w, main.w - 12); assert.equal(self.y + self.h, main.h - 12);
});

test("the thumbnail share is configurable and halves under a shared screen", () => {
  const wide = planScene({ scene: "pip", tiles: [me, agent], viewerRole: "customer", box: { width: 600, height: 600 }, thumbShare: 0.45 });
  const narrow = planScene({ scene: "pip", tiles: [me, agent], viewerRole: "customer", box: { width: 600, height: 600 }, thumbShare: 0.15 });
  assert.equal(wide.rects[1].w, 270); assert.equal(narrow.rects[1].w, 90);
  const screenPip = planScene({ scene: "pip", tiles: [me, agent, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 600, height: 600 }, thumbShare: 0.3 });
  assert.equal(screenPip.rects[0].id, "agent:screen"); assert.ok(screenPip.rects[1].w < 600 * 0.3 * 0.7);
});

test("three thumbnails shrink to stay inside a narrow main frame", () => {
  const plan = planScene({ scene: "pip", tiles: [me, agent, supervisor, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 296, height: 600 } });
  const [main, ...thumbs] = plan.rects;
  assert.equal(main.id, "agent:screen"); assert.equal(thumbs.length, 3);
  for (const t of thumbs) { assert.ok(t.x >= 0 && t.x + t.w <= main.w, `thumbnail ${t.id} inside (${t.x}..${t.x + t.w} of ${main.w})`); assert.ok(Math.abs(ratio(t) - A) < 0.05); }
  assert.ok(thumbs[0].x + thumbs[0].w <= thumbs[1].x && thumbs[1].x + thumbs[1].w <= thumbs[2].x, "thumbnails do not overlap");
});

test("split packs equal 4:3 tiles: two side by side or stacked, three as two plus one centered, four as a grid", () => {
  const two = planScene({ scene: "split", tiles: [me, agent], viewerRole: "customer", box: { width: 1000, height: 600 } });
  assert.equal(two.rects.length, 2); assert.equal(two.rects[0].y, two.rects[1].y); assert.equal(two.rects[0].w, two.rects[1].w);
  const stacked = planScene({ scene: "split", tiles: [me, agent], viewerRole: "customer", box: { width: 352, height: 700 }, orientation: "column" });
  assert.deepEqual(stacked.rects.map((r) => [r.w, r.h, r.x, r.y]), [[352, 264, 0, 0], [352, 264, 0, 272]]);
  const three = planScene({ scene: "split", tiles: [me, agent, supervisor], viewerRole: "customer", box: { width: 1000, height: 600 } });
  assert.equal(three.rects.length, 3);
  const bottom = three.rects[2];
  assert.equal(bottom.y, three.rects[0].h + 8); assert.equal(bottom.x, Math.round((three.rects[0].w + 8) / 2), "the third tile is centered under the pair");
  assert.ok(three.rects.every((r) => r.w === three.rects[0].w && Math.abs(ratio(r) - A) < 0.02));
  assert.ok(within(three, { width: 1000, height: 600 }) && disjoint(three.rects));
  const four = planScene({ scene: "split", tiles: [me, agent, supervisor, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 1000, height: 600 } });
  assert.equal(four.rects.length, 4); assert.equal(new Set(four.rects.map((r) => r.y)).size, 2); assert.equal(new Set(four.rects.map((r) => r.x)).size, 2);
  const fourPortrait = planScene({ scene: "split", tiles: [me, agent, supervisor, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 480, height: 420 }, orientation: "column" });
  assert.equal(new Set(fourPortrait.rects.map((r) => r.x)).size, 2, "four portrait tiles form a 2×2 grid"); assert.ok(fourPortrait.rects[0].w > 200);
});

test("spotlight puts the focus tile large with the others in a side column (landscape) or a row below (portrait)", () => {
  const land = planScene({ scene: "spotlight", tiles: [cam("self", "agent", true), customer, supervisor], viewerRole: "agent", box: { width: 1000, height: 600 } });
  const [main, ...strip] = land.rects;
  assert.equal(main.id, "cust"); assert.equal(strip.length, 2);
  assert.ok(strip.every((s) => s.x === main.w + 8 && s.w < main.w && Math.abs(ratio(s) - A) < 0.03));
  assert.equal(strip[1].y, strip[0].h + 8); assert.ok(Math.abs(main.h - (strip[0].h * 2 + 8)) <= 2, "the main tile is as tall as the strip");
  assert.ok(within(land, { width: 1000, height: 600 }) && disjoint(land.rects));
  // A shared screen in focus: the strip tiles are about half as wide as with a camera focus.
  const camFocus = planScene({ scene: "spotlight", tiles: [me, agent, supervisor], viewerRole: "customer", box: { width: 1000, height: 600 } });
  const screenFocus = planScene({ scene: "spotlight", tiles: [me, agent, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 1000, height: 600 } });
  assert.equal(screenFocus.rects[0].id, "agent:screen");
  assert.ok(screenFocus.rects[1].w < camFocus.rects[1].w * 0.6, `strip shrinks under a screen (${screenFocus.rects[1].w} vs ${camFocus.rects[1].w})`);
  assert.ok(within(screenFocus, { width: 1000, height: 600 }) && disjoint(screenFocus.rects));
  const four = planScene({ scene: "spotlight", tiles: [me, agent, supervisor, screen("agent:screen", "agent")], viewerRole: "customer", box: { width: 1000, height: 600 } });
  assert.equal(four.rects.length, 4); assert.ok(four.width <= 1000, `four-tile spotlight fits the width (${four.width})`); assert.ok(within(four, { width: 1000, height: 600 }) && disjoint(four.rects));
  const port = planScene({ scene: "spotlight", tiles: [me, agent, supervisor], viewerRole: "customer", box: { width: 352, height: 700 }, orientation: "column" });
  const [pm, ...pstrip] = port.rects;
  assert.deepEqual([pm.w, pm.h], [352, 264]); assert.equal(pstrip.length, 2);
  assert.ok(pstrip.every((s) => s.y === pm.h + 8 && Math.abs(ratio(s) - A) < 0.03)); assert.equal(pstrip[0].w + 8 + pstrip[1].w, 352);
  assert.ok(within(port, { width: 352, height: 700 }));
});

test("every scene fits a short box on both axes and keeps the frames 4:3", () => {
  const box = { width: 720, height: 200 };
  for (const scene of VIDEO_SCENES) for (const orientation of ["row", "column"]) {
    const plan = planScene({ scene, tiles: [me, agent, supervisor], viewerRole: "customer", box, orientation });
    assert.ok(within(plan, box), `${scene}/${orientation} fits`);
    for (const r of plan.rects) assert.ok(Math.abs(ratio(r) - A) < 0.04, `${scene}/${orientation} ${r.id} keeps 4:3 (${ratio(r).toFixed(2)})`);
  }
});

test("fill mode stretches the arrangement to the box while thumbnails keep their proportions", () => {
  const box = { width: 900, height: 500 };
  const pip = planScene({ scene: "pip", tiles: [me, agent], viewerRole: "customer", box, fill: true });
  assert.deepEqual([pip.rects[0].w, pip.rects[0].h], [900, 500]); assert.ok(Math.abs(ratio(pip.rects[1]) - A) < 0.03);
  const split = planScene({ scene: "split", tiles: [me, agent], viewerRole: "customer", box, fill: true });
  assert.deepEqual([split.width, split.height], [900, 500]); assert.equal(split.rects[0].h, 500);
  const spot = planScene({ scene: "spotlight", tiles: [me, agent, supervisor], viewerRole: "customer", box, fill: true });
  assert.deepEqual([spot.width, spot.height], [900, 500]); assert.equal(spot.rects[0].x, 0);
});

test("scene aspect drives the enlarged modal: one frame 4:3, two side by side about 8:3, spotlight wider than a frame", () => {
  assert.ok(Math.abs(sceneAspect({ scene: "pip", count: 2 }) - A) < 0.01);
  assert.ok(Math.abs(sceneAspect({ scene: "split", count: 2 }) - 8 / 3) < 0.05);
  assert.ok(Math.abs(sceneAspect({ scene: "split", count: 2, orientation: "column" }) - 2 / 3) < 0.05);
  assert.ok(sceneAspect({ scene: "spotlight", count: 3 }) > A);
  assert.ok(Math.abs(sceneAspect({ scene: "remote", count: 1 }) - A) < 0.01);
});
