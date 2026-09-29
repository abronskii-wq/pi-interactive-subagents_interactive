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
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySubagentLayout } from "./pane-layout.ts";

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

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven sizes.
 * Applies the pane layout policy (see pane-layout.ts) to the parent pi window.
 * Debounced so a burst of parallel spawns or staggered exits collapses into a
 * single layout call, and non-fatal: a cosmetic resize must never break
 * spawning or watching.
 */
function rebalanceSurfaces(parentPane?: string): void {
  // Use an explicit parent when supplied; the process may be running inside a
  // different psmux session. The parent survives subagent pane closure.
  const target = parentPane ?? process.env.TMUX_PANE;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      applySubagentLayout(target);
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
  // the target id. Applying the layout policy first restores the parent to its
  // policy size so splits keep succeeding. Cosmetic on failure.
  if (fromSurface) {
    try {
      applySubagentLayout(fromSurface);
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
          rebalanceSurfaces(fromSurface ?? process.env.TMUX_PANE);
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
 * Verify that a pane target resolves to ITSELF. psmux 3.3.8 resolves `%N`
 * targets only within its "current" session: when the id exists only in
 * another session it silently returns the current session's active pane with
 * exit code 0 (observed: `-t %39` -> `%2` of an unrelated session). send-keys
 * then succeeds while typing into the WRONG pane, and the launch command is
 * never executed. Detect the remap by echoing the target's own id back.
 *
 * Retried briefly: the pane registry may lag right after a split.
 * Throws when the target persistently resolves to a different pane.
 */
export function verifyPaneTarget(surface: string): void {
  requireTmux();
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resolved = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", surface, "#{pane_id}"],
        { encoding: "utf8", timeout: 5_000 },
      ).trim();
      if (resolved === surface) return;
      lastError = new Error(
        `tmux target ${surface} resolves to ${resolved || "<empty>"} (cross-session pane remap?)`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < 4) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
    }
  }
  throw lastError ?? new Error(`tmux target ${surface} could not be verified`);
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  // Guard against the psmux cross-session `%N` remap: never type into a pane
  // whose identity we cannot confirm. A failed send must raise here, not
  // silently strand the watcher waiting for a process that never started.
  verifyPaneTarget(surface);
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
 * Close a pane and rebuild the surviving window by its current pane count.
 * Pass a qualified parentPane when the pane belongs to another psmux session.
 */
export function closeSurface(surface: string, parentPane = process.env.TMUX_PANE): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces(parentPane);
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
    /**
     * Sub-agent activity file (PI_SUBAGENT_ACTIVITY_FILE). Its creation is a
     * sign of life: only a running child pi writes it. Used by the startup
     * watchdog to confirm the launch command actually executed.
     */
    activityFile?: string;
    /**
     * Max time (ms) to wait for ANY sign that the launch command executed
     * (activity file, launchlog, or a session file touched after start).
     * Without it a lost send-keys (psmux `%N` cross-session remap, dropped
     * input during shell init) strands the watcher forever. 0/undefined
     * disables the watchdog.
     */
    startupDeadlineMs?: number;
    /**
     * Grace period (ms) after the pane becomes unreadable before declaring it
     * gone. A destroyed pane without an exit marker is an error, not an
     * infinite wait. Defaults to 30_000 when startupDeadlineMs is set.
     */
    paneGoneGraceMs?: number;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const startupDeadlineMs = options.startupDeadlineMs ?? 0;
  const paneGoneGraceMs = options.paneGoneGraceMs ?? 30_000;
  let started = false;
  let paneGoneSince: number | null = null;

  // A sign of life proves the launch script/pi actually ran in the pane.
  // Session files in seeded modes are pre-created by the parent, so the file
  // must have been TOUCHED after launch to count.
  const hasSignOfLife = (): boolean => {
    try {
      if (options.activityFile && existsSync(options.activityFile)) return true;
    } catch {}
    try {
      if (options.sessionFile) {
        if (existsSync(`${options.sessionFile}.launchlog`)) return true;
        if (existsSync(options.sessionFile) && statSync(options.sessionFile).mtimeMs >= start - 1000) {
          return true;
        }
      }
    } catch {}
    return false;
  };

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Startup watchdog: no sign of life past the deadline means the launch
    // command never executed (lost/remapped send-keys). Fail loudly instead
    // of parking the parent tree forever.
    if (startupDeadlineMs > 0 && !started) {
      if (hasSignOfLife()) {
        started = true;
      } else if (Date.now() - start > startupDeadlineMs) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage:
            `launch_failed: no launcher, session, or activity activity within ` +
            `${Math.round(startupDeadlineMs / 1000)}s — the launch command likely never ` +
            `executed in pane ${surface} (lost or mis-targeted send-keys). ` +
            `Do NOT steer this pane; spawn a fresh sub-agent instead.`,
        };
      }
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
      paneGoneSince = null;
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
      // An unreadable/destroyed pane with no exit marker is a terminal
      // failure, not a state worth waiting on forever.
      if (paneGoneSince === null) {
        paneGoneSince = Date.now();
      } else if (Date.now() - paneGoneSince > paneGoneGraceMs) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage:
            `Pane ${surface} has been unreadable for >${Math.round(paneGoneGraceMs / 1000)}s ` +
            `without an exit marker — the sub-agent is gone without reporting. Treating as failed.`,
        };
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
