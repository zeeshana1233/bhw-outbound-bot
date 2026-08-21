/**
 * Bot State — Global Singleton
 *
 * Holds runtime flags shared across every engine:
 *   • paused   — all engine tick loops skip their work when true
 *   • dryRun   — comment/DM/reply engines print but do not send
 *
 * Because Node.js caches ESM modules, every `import { botState }` in the
 * codebase points at the exact same object. Changing a flag here immediately
 * affects every engine on the next tick — no restarts required.
 *
 * Usage:
 *   import { botState } from '../utils/botState.js';
 *   if (botState.isPaused()) return;          // guard at top of each tick
  *   botState.pause('manual via Discord');    // called from commandCenter
 *   botState.resume();
 */

import dotenv from 'dotenv';
dotenv.config();

let _paused       = false;
let _pausedReason = '';
let _pausedAt     = null;
let _dryRun       = process.env.DRY_RUN !== 'false'; // default: true (safe)
let _startedAt    = new Date();

export const botState = {
  // ── Reads ──────────────────────────────────────────────────────────────────
  isPaused:     () => _paused,
  pausedReason: () => _pausedReason,
  pausedAt:     () => _pausedAt,
  isDryRun:     () => _dryRun,
  startedAt:    () => _startedAt,

  uptimeString() {
    const sec  = Math.floor((Date.now() - _startedAt.getTime()) / 1000);
    const h    = Math.floor(sec / 3600);
    const m    = Math.floor((sec % 3600) / 60);
    const s    = sec % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  },

  // ── Mutations ──────────────────────────────────────────────────────────────
  pause(reason = 'manual') {
    _paused       = true;
    _pausedReason = reason;
    _pausedAt     = new Date();
  },

  resume() {
    _paused       = false;
    _pausedReason = '';
    _pausedAt     = null;
  },

  setDryRun(val) {
    _dryRun = !!val;
  },

  // ── Summary (used by STATUS command) ──────────────────────────────────────
  summary() {
    return {
      paused:       _paused,
      pausedReason: _pausedReason,
      pausedAt:     _pausedAt,
      dryRun:       _dryRun,
      uptime:       this.uptimeString(),
    };
  },
};
