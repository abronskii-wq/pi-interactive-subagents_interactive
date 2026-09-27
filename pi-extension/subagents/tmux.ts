/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    // Probe tmux directly: PowerShell launches on Windows may have tmux on PATH
    // without having Git Bash's sh.exe on PATH.
    execFileSync(command, ["-V"], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

let paneTitleBarsConfigured = false;

/**
 * Show each pane's title in a thin border bar so subagent panes are easy to
 * tell apart without colour. psmux stores these as global options, so this is
 * applied once per process and kept muted (plain title text, default border).
 * Best-effort: if it fails, the -T title is still set on the pane.
 */
function ensurePaneTitleBars(): void {
  if (paneTitleBarsConfigured) return;
  paneTitleBarsConfigured = true;
  try {
    execFileSync("tmux", ["set-option", "-g", "pane-border-status", "top"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    // psmux renders the border label via plain string replace of
    // #{pane_title}/#{pane_index}/#P only — inline #[fg=...] styles are NOT
    // parsed and would render as literal text. Keep the format plain.
    execFileSync("tmux", ["set-option", "-g", "pane-border-format", " #{pane_title} "], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    // Best effort; the per-pane title remains set regardless.
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns), "main-vertical" (big main
 * pane + tiled column), "tiled" (grid: rows + columns).
 */
const SUBAGENT_TMUX_LAYOUT = "tiled";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // pane title is set by createSurfaceSplit (locked via -T).
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  // Distinguish subagent panes by a locked title (the child pi's own OSC
  // title cannot overwrite a title set with -T). Kept as plain text so the
  // label stays muted, not a bright per-pane colour.
  const title = (name ?? "")
    .replace(/[\r\n\x00-\x1f]/g, "")
    .trim()
    .slice(0, 40) || "subagent";
  args.push("-T", title);
  ensurePaneTitleBars();
  if (process.platform === "win32") {
    // psmux 3.3.8 auto-appends `-c <cwd>` to every CLI split-window and, on
    // the warm-pane transplant path, re-homes the pane with PowerShell syntax
    // injected into a Git Bash shell (rehome_command picks by cfg!(windows)).
    // The syntax error cycle races with the launch command and eats its first
    // byte (`bash` -> `ash`). A non-empty -e bypasses the warm transplant
    // (pane.rs gates it on extra_env.is_empty()), forcing the cold-spawn path
    // which sets the pane cwd directly without any rehome.
    args.push("-e", "PI_SUBAGENT_COLD_START=1");
  }
  args.push("-P", "-F", "#{pane_id}");

  // Rebalance the target's window BEFORE splitting. psmux halves the target
  // pane on every split; a burst of parallel launches can shrink the parent
  // below MIN_SPLIT_COLS (21) so the next split fails silently and returns
  // the target id. Equalising first widens the target so splits keep
  // succeeding. Cosmetic on failure.
  if (fromSurface) {
    try {
      execFileSync("tmux", ["select-layout", "-t", fromSurface, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch {
      // best effort
    }
  }

  // psmux SplitWindowPrint swallows split failures and expands #{pane_id}
  // against the still-active OLD pane, so a failed split "succeeds" returning
  // the TARGET id. Accept only a fresh, live, different pane; retry transient
  // failures a bounded number of times.
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let pane = "";
    try {
      pane = execFileSync("tmux", args, { encoding: "utf8", timeout: 15_000 }).trim();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (pane.startsWith("%") && pane !== fromSurface) {
      try {
        const live = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], {
          encoding: "utf8",
          timeout: 10_000,
        });
        if (live.split(/\r?\n/).includes(pane)) {
          rebalanceSurfaces(pane);
          return pane;
        }
        lastError = new Error(`tmux split-window returned ${pane} but no such pane exists`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    } else {
      lastError = new Error(
        pane === fromSurface
          ? `tmux split-window returned the target pane id (${pane}) instead of a new pane`
          : `Unexpected tmux split-window output: ${pane || "<empty>"}`,
      );
    }
    if (attempt < 3) {
      // psmux errors under load are transient; back off before retrying.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * attempt);
    }
  }
  throw new Error(`${lastError?.message ?? "tmux split-window failed"} (3 attempts). Aborting launch.`);
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  // Pad with leading spaces so a dropped first byte in the terminal transport
  // (observed as `bash` -> `ash`) consumes whitespace, never a command byte.
  // Bash ignores leading whitespace before a command.
  sendCommand(surface, `   bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
