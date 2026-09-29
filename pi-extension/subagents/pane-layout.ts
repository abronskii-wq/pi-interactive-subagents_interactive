/**
 * Pane layout policy for the subagent window.
 *
 * The pi pane stays a tall column on the left; subagent panes fill the right
 * zone. Sizes are computed as fractions of the current window, never stored as
 * absolute numbers, so one policy holds for any window size: psmux rescales an
 * applied layout proportionally when the window resizes.
 *
 * Growth rule, measured table and the psmux quirks this file works around are
 * documented in PANE-LAYOUT-POLICY.md.
 */
import { execFileSync } from "node:child_process";

/** Named layout used when the policy does not apply (see resolveLayout). */
export const LAYOUT_FALLBACK = "tiled";

/** Parent column share of window width: few agents get a wider parent. */
export const PARENT_SHARE_SMALL = 0.6;
export const PARENT_SHARE_LARGE = 0.4;

/**
 * Parent pane share of the left column height when a section sits below it.
 * The remainder holds the agents that do not fit into the right zone.
 */
export const PARENT_COLUMN_SHARE = 0.79;

/** Policy is defined for at most eight agents (nine panes in total). */
const MAX_AGENTS = 8;

/** Degenerate geometry guard: below this the policy gives up (fallback). */
const MIN_AGENT_WIDTH = 10;
const MIN_AGENT_HEIGHT = 5;

// ── Shape ──

/**
 * Where agents go for a given count: `under` sit in the section below the
 * parent pane, `right` fill the right zone (one or two columns).
 * Returns null when the count is outside the policy.
 */
export function policyShape(agents: number): { under: number; right: number } | null {
  if (agents < 0 || agents > MAX_AGENTS) return null;
  if (agents <= 4) return { under: 0, right: agents };
  if (agents === 5) return { under: 1, right: 4 };
  return { under: 2, right: agents - 2 };
}

/**
 * Split `total` cells into `n` parts, removing `n - 1` borders first.
 * Largest-remainder distribution: equal inputs give equal outputs.
 */
export function splitEven(total: number, n: number): number[] {
  if (n <= 0) return [];
  const usable = Math.max(total - (n - 1), n);
  const per = Math.floor(usable / n);
  const rest = usable - per * n;
  return Array.from({ length: n }, (_, i) => per + (i < rest ? 1 : 0));
}

// ── Layout string ──

type LayoutNode =
  | { kind: "leaf" }
  | { kind: "h"; children: LayoutNode[]; sizes: number[] }
  | { kind: "v"; children: LayoutNode[]; sizes: number[] };

const leaf = (): LayoutNode => ({ kind: "leaf" });

/**
 * tmux layout checksum over a layout body (the string without "<csum>,").
 * Verified against layouts produced by psmux itself.
 */
export function layoutChecksum(layout: string): number {
  let c = 0;
  for (let i = 0; i < layout.length; i++) {
    c = ((c >> 1) | ((c & 1) << 15)) & 0xffff;
    c = (c + layout.charCodeAt(i)) & 0xffff;
  }
  return c;
}

/**
 * Build the tree for `agents` agents in a `W x H` window.
 * h = panes side by side, v = panes stacked.
 */
function layoutTree(agents: number, shape: { under: number; right: number }, W: number, H: number): LayoutNode {
  const parentWidth = Math.round(W * (agents <= 3 ? PARENT_SHARE_SMALL : PARENT_SHARE_LARGE));
  const zoneWidth = W - parentWidth - 1;

  let left: LayoutNode;
  if (shape.under === 0) {
    left = leaf();
  } else {
    const parentHeight = Math.round(H * PARENT_COLUMN_SHARE);
    const section: LayoutNode =
      shape.under === 1
        ? leaf()
        : { kind: "h", children: Array.from({ length: shape.under }, leaf), sizes: splitEven(parentWidth, shape.under) };
    left = { kind: "v", children: [leaf(), section], sizes: [parentHeight, H - parentHeight - 1] };
  }

  let zone: LayoutNode;
  if (shape.right === 1) {
    // A one-child container is not a real split. psmux can destroy the whole
    // window when its only child is later killed (2 panes -> 1).
    zone = leaf();
  } else if (shape.right <= 3) {
    zone = { kind: "v", children: Array.from({ length: shape.right }, leaf), sizes: splitEven(H, shape.right) };
  } else {
    const a = Math.floor(shape.right / 2);
    const b = shape.right - a;
    const column = (n: number): LayoutNode => ({
      kind: "v",
      children: Array.from({ length: n }, leaf),
      sizes: splitEven(H, n),
    });
    zone = { kind: "h", children: [column(a), column(b)], sizes: splitEven(zoneWidth, 2) };
  }

  return { kind: "h", children: [left, zone], sizes: [parentWidth, zoneWidth] };
}

/**
 * Emit a tmux layout string. A container MUST carry its own `WxH,X,Y` prefix
 * before `{...}`/`[...]`: psmux silently ignores a layout whose container omits
 * it (select-layout returns 0 and changes nothing).
 */
function emit(node: LayoutNode, w: number, h: number, x: number, y: number, ids: Iterator<number>): string {
  if (node.kind === "leaf") {
    const id = ids.next();
    if (id.done) throw new Error("layout: not enough panes for the tree");
    return `${w}x${h},${x},${y},${id.value}`;
  }
  const parts: string[] = [];
  let offset = 0;
  if (node.kind === "h") {
    for (let i = 0; i < node.children.length; i++) {
      const cw = node.sizes[i];
      parts.push(emit(node.children[i], cw, h, x + offset, y, ids));
      offset += cw + 1;
    }
    return `${w}x${h},${x},${y}{${parts.join(",")}}`;
  }
  for (let i = 0; i < node.children.length; i++) {
    const ch = node.sizes[i];
    parts.push(emit(node.children[i], w, ch, x, y + offset, ids));
    offset += ch + 1;
  }
  return `${w}x${h},${x},${y}[${parts.join(",")}]`;
}

/** Smallest leaf size in a placed tree (degenerate-geometry guard). */
function minLeafSize(node: LayoutNode, w: number, h: number): { w: number; h: number } {
  if (node.kind === "leaf") return { w, h };
  let min = { w: Number.MAX_SAFE_INTEGER, h: Number.MAX_SAFE_INTEGER };
  for (let i = 0; i < node.children.length; i++) {
    const size = node.sizes[i];
    const child =
      node.kind === "h"
        ? minLeafSize(node.children[i], size, h)
        : minLeafSize(node.children[i], w, size);
    min = { w: Math.min(min.w, child.w), h: Math.min(min.h, child.h) };
  }
  return min;
}

/**
 * Layout string for `agents` agents in a `W x H` window with `paneIds` in the
 * order psmux assigns cells (parent pane first, then newest pane first).
 * Returns null when the policy does not apply and the caller must fall back.
 */
export function buildLayoutString(W: number, H: number, paneIds: string[], agents: number): string | null {
  const shape = policyShape(agents);
  // A single parent pane already fills the window; there is no split to encode.
  if (!shape || agents === 0) return null;
  if (paneIds.length !== agents + 1) return null;
  const ids = paneIds.map((id) => Number(id.replace(/^%/, "")));
  if (ids.some((n) => !Number.isInteger(n))) return null;

  const tree = layoutTree(agents, shape, W, H);
  const min = minLeafSize(tree, W, H);
  if (min.w < MIN_AGENT_WIDTH || min.h < MIN_AGENT_HEIGHT) return null;

  const body = emit(tree, W, H, 0, 0, ids[Symbol.iterator]());
  return `${layoutChecksum(body).toString(16).padStart(4, "0")},${body}`;
}

// ── Applied policy ──

function listPaneIds(target: string): string[] {
  const out = execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return out.split(/\r?\n/).filter((line) => line.startsWith("%"));
}

function windowSize(target: string): { W: number; H: number } {
  const out = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{window_width} #{window_height}"], {
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  const [W, H] = out.split(/\s+/).map(Number);
  return { W, H };
}

function applyLayout(target: string, layout: string): void {
  // -t <pane> resolves to that pane's window and does not change focus.
  execFileSync("tmux", ["select-layout", "-t", target, layout], { encoding: "utf8", timeout: 5_000 });
}

/**
 * Resolve the layout string for the window holding `parentPane`.
 * Returns null for a single pane, more than eight agents, or geometry below
 * the guard. Throws if the parent is not pane 0: falling back to `tiled` would
 * rearrange a window that does not belong to this parent.
 */
export function resolveLayout(parentPane: string): string | null {
  // A pane may be addressed as either %N (within the current session) or as
  // session:window.pane. Compare the resolved pane id, not the target string.
  // All tmux calls must keep using the original target: bare %N is ambiguous
  // across psmux sessions, which can reuse the same pane id.
  const resolvedParent = execFileSync(
    "tmux", ["display-message", "-p", "-t", parentPane, "#{pane_id}"],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
  const ids = listPaneIds(parentPane);
  if (ids.length < 2) return null;
  if (ids[0] !== resolvedParent) {
    throw new Error(`Layout parent ${parentPane} is not pane 0 of its window`);
  }
  const { W, H } = windowSize(parentPane);
  const agents = ids.length - 1;
  return buildLayoutString(W, H, ids, agents);
}

/**
 * Apply the pane layout policy to the parent pi window. Best-effort by design:
 * unsupported counts and geometry fall back to a named layout. Callers catch
 * resolution failures so a cosmetic resize cannot break spawning or watching.
 */
export function applySubagentLayout(parentPane: string): void {
  const layout = resolveLayout(parentPane);
  applyLayout(parentPane, layout ?? LAYOUT_FALLBACK);
}
