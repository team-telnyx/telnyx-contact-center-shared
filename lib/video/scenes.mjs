// Scene planning for the 1:1, supervised and screen-sharing video call.
//
// A scene is a named arrangement of the visible tiles (cameras and screen
// shares) inside a box. The planner is pure geometry so the widget, the agent
// desktop, the supervisor panel and the tests share one implementation:
//
//   remote     the focus tile alone (the other side, or a shared screen)
//   pip        the focus tile full frame, the remaining tiles as a row of
//              thumbnails along the bottom-right edge (self last)
//   split      every tile the same size: two side by side (landscape) or
//              stacked (portrait); three as two on top and one centered below
//              (landscape) or a column (portrait); four as a 2×2 grid
//   spotlight  the focus tile large, the remaining tiles in a strip: a column
//              on the right (landscape) or a row underneath (portrait)
//
// Every camera tile keeps `aspect` (4:3 by default) when `fill` is false: the
// scene is the largest such arrangement that fits the box, top-aligned and
// centered horizontally. With `fill` the scene stretches to the box (the agent
// desktop) and only the thumbnails keep their proportions.

export const VIDEO_SCENES = ["remote", "split", "pip", "spotlight"];
export const DEFAULT_VIDEO_SCENE = "pip";
export const MAX_VISIBLE_TILES = 4;

const PRIMARY_REMOTE = { customer: "agent", agent: "customer", supervisor: "customer" };

export function isVideoScene(value) {
  return VIDEO_SCENES.includes(value);
}

// Picks the tile the scene is built around: a shared screen wins (the
// sharer's own included, so both sides see the same main frame), then the
// counterpart of the viewer's role, then any other remote camera, then self.
export function focusTile(tiles, viewerRole) {
  const remote = tiles.filter((tile) => !tile.self);
  return tiles.find((tile) => tile.kind === "screen")
    || remote.find((tile) => tile.role === PRIMARY_REMOTE[viewerRole] && tile.kind === "camera")
    || remote.find((tile) => tile.kind === "camera")
    || remote[0]
    || tiles.find((tile) => tile.self && tile.kind === "camera")
    || tiles[0]
    || null;
}

// Visible tiles in display order: focus first, other remote tiles, self last.
export function orderTiles(tiles, viewerRole) {
  const focus = focusTile(tiles, viewerRole);
  if (!focus) return [];
  const rest = tiles.filter((tile) => tile !== focus);
  const remote = rest.filter((tile) => !tile.self);
  const own = rest.filter((tile) => tile.self);
  return [focus, ...remote, ...own].slice(0, MAX_VISIBLE_TILES);
}

// Portrait stacks up to three tiles; four become a 2×2 grid on both axes.
function gridShape(count, landscape) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (!landscape && count < 4) return { cols: 1, rows: count };
  return { cols: 2, rows: Math.ceil(count / 2) };
}

// Largest scene of the given shape inside the box; returns the scene size and
// the size of one tile.
function fitGrid(box, { cols, rows, aspect, gap }) {
  const fromWidth = (box.width - gap * (cols - 1)) / cols;
  const fromHeight = ((box.height - gap * (rows - 1)) / rows) * aspect;
  const tile = Math.max(0, Math.floor(Math.min(fromWidth, fromHeight)));
  return { tile, width: tile * cols + gap * (cols - 1), height: Math.round((tile / aspect) * rows + gap * (rows - 1)) };
}

function gridRects(ids, { cols, rows }, tile, aspect, gap) {
  const tileHeight = tile / aspect;
  const rects = [];
  ids.forEach((id, index) => {
    const row = Math.floor(index / cols);
    const inRow = row === rows - 1 ? ids.length - row * cols : cols;
    // A short last row (three tiles in two columns) is centered.
    const offset = ((cols - inRow) * (tile + gap)) / 2;
    const col = index - row * cols;
    rects.push({ id, x: Math.round(offset + col * (tile + gap)), y: Math.round(row * (tileHeight + gap)), w: tile, h: Math.round(tileHeight), kind: "grid" });
  });
  return rects;
}

// Spotlight, landscape: the strip on the right holds up to three tiles of
// width s; the main tile spans `k` strip widths: k = rows of the strip, so
// the main tile is as tall as the strip column, or twice that when the focus
// is a shared screen (cameras shrink to give the screen room).
function spotlightLandscape(box, ids, aspect, gap, { compact = false } = {}) {
  const stripCount = ids.length - 1;
  const rowsNeeded = Math.max(2, stripCount);
  const k = compact ? rowsNeeded * 2 : rowsNeeded;
  // main width = k strip widths plus the gaps between strip rows; one more
  // gap separates it from the strip. Height: the main tile keeps the aspect.
  const stripFromWidth = (box.width - gap * rowsNeeded) / (1 + k);
  const stripFromHeight = compact ? (box.height * aspect - gap * (rowsNeeded - 1)) / k : ((box.height - gap * (rowsNeeded - 1)) / rowsNeeded) * aspect;
  const s = Math.max(0, Math.floor(Math.min(stripFromWidth, stripFromHeight)));
  const stripHeight = s / aspect;
  const stripColumn = Math.round(stripHeight * rowsNeeded + gap * (rowsNeeded - 1));
  const mainWRaw = Math.round(s * k + gap * (rowsNeeded - 1));
  // Camera focus: the main tile is exactly as tall as the strip column and
  // keeps the aspect by width. Screen focus: the main tile keeps the aspect
  // at full width and the smaller strip sits top-aligned beside it.
  const mainH = compact ? Math.round(mainWRaw / aspect) : stripColumn;
  const mainW = compact ? mainWRaw : Math.min(mainWRaw, Math.round(mainH * aspect));
  const rects = [{ id: ids[0], x: 0, y: 0, w: mainW, h: mainH, kind: "main" }];
  ids.slice(1).forEach((id, index) => rects.push({ id, x: mainW + gap, y: Math.round(index * (stripHeight + gap)), w: s, h: Math.round(stripHeight), kind: "strip" }));
  return { width: mainW + gap + s, height: mainH, rects };
}

// Spotlight, portrait: the main tile on top, the strip as a row underneath.
function spotlightPortrait(box, ids, aspect, gap, { compact = false } = {}) {
  // The strip holds at least two columns so a lone self preview stays small;
  // under a shared screen the cameras shrink to a row of three.
  const stripCols = Math.min(Math.max(compact ? 3 : 2, ids.length - 1), 3);
  // width W: main W×W/aspect, strip tiles (W - gaps)/cols wide.
  const stripTile = (W) => (W - gap * (stripCols - 1)) / stripCols;
  const heightFor = (W) => W / aspect + gap + stripTile(W) / aspect;
  let W = box.width;
  if (heightFor(W) > box.height) {
    // Solve heightFor(W) = box.height linearly: W/a + g + (W - g(c-1))/(c a) = H
    const c = stripCols, a = aspect;
    W = ((box.height - gap) * a + gap * (c - 1) / c) / (1 + 1 / c);
  }
  W = Math.max(0, Math.floor(W));
  const mainH = Math.round(W / aspect);
  const s = Math.floor(stripTile(W));
  const sH = Math.round(s / aspect);
  const rects = [{ id: ids[0], x: 0, y: 0, w: W, h: mainH, kind: "main" }];
  ids.slice(1).forEach((id, index) => rects.push({ id, x: Math.round(index * (s + gap)), y: mainH + gap, w: s, h: sH, kind: "strip" }));
  return { width: W, height: mainH + (ids.length > 1 ? gap + sH : 0), rects };
}

function thumbnails(main, ids, aspect, { margin = 12, gap = 8, share = 0.3 } = {}) {
  if (!ids.length) return [];
  // `share` of the main frame (30 % by default), at least 64 px, but never
  // wider than the room three thumbnails have between the margins.
  const fits = Math.floor((main.w - 2 * margin - gap * (ids.length - 1)) / ids.length);
  const w = Math.max(0, Math.min(Math.round(Math.max(64, Math.min(320, main.w * share))), fits));
  const h = Math.round(w / aspect);
  // Placed right to left so the self preview (the last id) sits in the corner.
  const fromRight = [...ids].reverse();
  const rects = fromRight.map((id, index) => ({ id, x: main.x + main.w - margin - w - index * (w + gap), y: main.y + main.h - margin - h, w, h, kind: "thumb" }));
  return ids.map((id) => rects.find((rect) => rect.id === id));
}

/**
 * Plans a scene inside `box` ({ width, height }).
 *
 * `tiles`: [{ id, role, kind: "camera" | "screen", self: boolean }]
 * Returns { scene, width, height, rects: [{ id, x, y, w, h, kind }], hidden: [id] }
 * with rects relative to the scene's top-left corner.
 */
export function planScene({ scene = DEFAULT_VIDEO_SCENE, tiles = [], viewerRole = "customer", box, orientation = "row", aspect = 4 / 3, gap = 8, fill = false, thumbShare = 0.3 }) {
  const ordered = orderTiles(tiles, viewerRole);
  // A shared screen as the focus: cameras step back (smaller thumbnails and strip).
  const screenFocus = ordered[0]?.kind === "screen";
  const width = Math.max(0, Math.floor(box?.width || 0)), height = Math.max(0, Math.floor(box?.height || 0));
  const empty = { scene, width: 0, height: 0, rects: [], hidden: tiles.map((tile) => tile.id) };
  if (!ordered.length || !width || !height) return empty;
  const landscape = orientation !== "column";
  const ids = ordered.map((tile) => tile.id);
  const single = ordered.length === 1 ? "remote" : isVideoScene(scene) ? scene : DEFAULT_VIDEO_SCENE;
  let plan;
  if (single === "remote" || single === "pip") {
    const w = fill ? width : Math.min(width, Math.floor(height * aspect));
    const h = fill ? height : Math.round(w / aspect);
    const main = { id: ids[0], x: 0, y: 0, w, h, kind: "main" };
    const rest = single === "pip" ? ids.slice(1).slice(0, 3) : [];
    plan = { width: w, height: h, rects: [main, ...thumbnails(main, rest, aspect, { gap, share: screenFocus ? thumbShare * 0.66 : thumbShare })] };
  } else if (single === "split") {
    const shape = gridShape(ids.length, landscape);
    const fitted = fitGrid({ width, height }, { ...shape, aspect, gap });
    plan = { width: fitted.width, height: fitted.height, rects: gridRects(ids, shape, fitted.tile, aspect, gap) };
  } else {
    plan = landscape ? spotlightLandscape({ width, height }, ids, aspect, gap, { compact: screenFocus }) : spotlightPortrait({ width, height }, ids, aspect, gap, { compact: screenFocus });
  }
  if (fill && single !== "remote" && single !== "pip" && plan.width && plan.height) {
    // The agent desktop stretches the arrangement to its box; cameras cover.
    const sx = width / plan.width, sy = height / plan.height;
    plan = { width, height, rects: plan.rects.map((rect) => ({ ...rect, x: Math.round(rect.x * sx), y: Math.round(rect.y * sy), w: Math.round(rect.w * sx), h: Math.round(rect.h * sy) })) };
  }
  const shown = new Set(plan.rects.map((rect) => rect.id));
  return { scene: single, width: plan.width, height: plan.height, rects: plan.rects, hidden: tiles.map((tile) => tile.id).filter((id) => !shown.has(id)) };
}

// Composite aspect of a scene for a given tile count and orientation, used
// by the widget to size the enlarged modal before the box exists.
export function sceneAspect({ scene = DEFAULT_VIDEO_SCENE, count = 2, orientation = "row", aspect = 4 / 3, gap = 8 } = {}) {
  const probe = { width: 4000, height: 4000 };
  const tiles = Array.from({ length: Math.max(1, Math.min(MAX_VISIBLE_TILES, count)) }, (_, index) => ({ id: `t${index}`, role: index === 0 ? "agent" : "customer", kind: "camera", self: index === count - 1 && count > 1 }));
  const plan = planScene({ scene, tiles, viewerRole: "customer", box: probe, orientation, aspect, gap });
  return plan.height ? plan.width / plan.height : aspect;
}
