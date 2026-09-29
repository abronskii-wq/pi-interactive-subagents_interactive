import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applySubagentLayout, resolveLayout } from "../../pi-extension/subagents/pane-layout.ts";
import { closeSurface } from "../../pi-extension/subagents/tmux.ts";

const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 }).trim();
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300)); // 120 ms debounce

describe("pane layout after arbitrary agent exits", { skip: !process.env.TMUX }, () => {
  it("rebuilds by live count through 9 -> 5 -> 7 -> 1 in a separate session", { timeout: 60_000 }, async () => {
    const session = `pi_layout_reverse_${process.pid}_${Date.now()}`;
    const target = `${session}:0`;
    const parent = `${target}.0`;
    const rows = () => tmux("list-panes", "-t", target, "-F",
      "#{pane_index}|#{pane_id}|#{pane_width}x#{pane_height}|#{pane_left},#{pane_top}").split(/\r?\n/);
    const geometry = () => rows().map((row) => {
      const [index, , size, position] = row.split("|");
      return `${index}|${size}|${position}`;
    });
    const parentId = () => tmux("display-message", "-p", "-t", parent, "#{pane_id}");

    function grow(): void {
      const before = rows();
      assert.ok(before.length < 9, "the test cannot exceed nine panes");
      const args = ["split-window", "-d", "-h", "-t", parent];
      if (process.platform === "win32") args.push("-e", "PI_SUBAGENT_COLD_START=1");
      args.push("-P", "-F", "#{pane_id}");
      const created = tmux(...args);
      const after = rows();
      assert.equal(after.length, before.length + 1, "a split must create exactly one pane");
      assert.ok(after.some((row) => row.split("|")[1] === created));
      applySubagentLayout(parent);
    }

    function closeAt(index: number): void {
      assert.ok(index > 0 && index < rows().length, "never close the parent pane");
      const before = rows().length;
      closeSurface(`${target}.${index}`, parent);
      assert.equal(rows().length, before - 1, "a close must remove exactly one pane");
    }

    async function assertAutomaticLayout(count: number): Promise<void> {
      await settle();
      assert.equal(rows().length, count);
      assert.equal(rows()[0].split("|")[1], originalParent, "the parent pane must survive");
      if (count === 1) {
        assert.deepEqual(geometry(), ["0|165x47|0,0"]);
        return;
      }
      assert.ok(resolveLayout(parent), `policy should be defined for ${count} panes`);
      const automatic = geometry();
      applySubagentLayout(parent);
      assert.deepEqual(automatic, geometry(), `the automatic layout at ${count} panes differs from the policy`);
    }

    tmux("new-session", "-d", "-s", session, "-x", "165", "-y", "47");
    const originalParent = parentId();
    try {
      for (let count = 2; count <= 9; count++) grow();
      await assertAutomaticLayout(9);
      // One burst; close non-adjacent agents, not just the latest four.
      for (const index of [8, 6, 4, 2]) closeAt(index);
      await assertAutomaticLayout(5);
      grow();
      grow();
      await assertAutomaticLayout(7);
      // Remove arbitrary survivors and check every intervening shape.
      for (const index of [1, 3, 2, 1, 2, 1]) {
        closeAt(index);
        await assertAutomaticLayout(rows().length);
      }
    } finally {
      try { tmux("kill-session", "-t", session); } catch { /* already exited */ }
    }
  });

  it("uses tiled above nine panes and restores the policy when one exits", { timeout: 40_000 }, async () => {
    const session = `pi_layout_overflow_${process.pid}_${Date.now()}`;
    const target = `${session}:0`;
    const parent = `${target}.0`;
    const panes = () => tmux("list-panes", "-t", target, "-F",
      "#{pane_id}|#{pane_width}x#{pane_height}|#{pane_left},#{pane_top}").split(/\r?\n/);
    tmux("new-session", "-d", "-s", session, "-x", "165", "-y", "47");
    try {
      for (let count = 2; count <= 10; count++) {
        const args = ["split-window", "-d", "-h", "-t", parent];
        if (process.platform === "win32") args.push("-e", "PI_SUBAGENT_COLD_START=1");
        tmux(...args);
        assert.equal(panes().length, count);
        applySubagentLayout(parent);
      }
      assert.equal(resolveLayout(parent), null, "custom policy stops above nine panes");
      assert.throws(() => resolveLayout(`${target}.1`), /is not pane 0/, "never rearrange a window from a child pane");
      const fallback = panes();
      tmux("select-layout", "-t", target, "tiled");
      assert.deepEqual(panes(), fallback, "above nine panes uses tiled");
      closeSurface(`${target}.1`, parent);
      await settle();
      assert.equal(panes().length, 9);
      assert.ok(resolveLayout(parent), "custom policy returns at nine panes");
      const automatic = panes();
      applySubagentLayout(parent);
      assert.deepEqual(panes(), automatic, "closing the tenth pane restores the custom policy");
    } finally {
      try { tmux("kill-session", "-t", session); } catch { /* already exited */ }
    }
  });
});
