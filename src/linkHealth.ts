/**
 * Is the link to the printer really lost? A pure rule set, tested in __tests__/linkHealth.test.ts. `LabelPrinter` runs it.
 *
 * Sources (see docs/BLE-HARDENING.md for the links):
 * - Linux `net/core/link_watch.c`: "Minimise down-time: drop delay for up event". An up event shows at once, a down event waits.
 * - NetworkManager `carrier-wait-timeout` (5 s) and systemd-networkd `IgnoreCarrierLoss` (3 to 5 s): a few seconds of grace
 *   before a lost carrier counts. `HEALTH_GRACE_MS` is 4 s.
 * - SWIM (Das, Gupta, Motivala 2002): a failed probe makes a node "suspected", not dead. Here: `wobbling`, then `lost`.
 * - Chen, Toueg, Aguilera (2002): a detector trades detection time against false alarms. Two hard failures in a row skip the wait.
 * - Gray failure (Huang et al. 2017): "connected" is not "healthy". This module judges the LINK only. A printer that is
 *   connected but silent on ~HS is a different question: `getStatus()` returns null, and the link stays `up`.
 * The numbers are our choice and are NOT measured on the printer.
 */

/** `unknown` = no link yet, or we closed it on purpose. `wobbling` = the link may be lost, not sure yet. */
export type LinkHealth = 'unknown' | 'up' | 'wobbling' | 'lost';

/** How long a link may stay down before it counts as lost (NetworkManager: 5 s, systemd-networkd: 3 to 5 s). */
export const HEALTH_GRACE_MS = 4000;

/** Hard failures in a row (a failed write, a failed reconnect) that make the loss certain at once. */
export const HARD_FAILS_FOR_LOST = 2;

export interface HealthState {
  health: LinkHealth;
  /** When the link was first seen down. null when it is not down. */
  downSince: number | null;
  /** Hard failures since the last sign of life. */
  hardFails: number;
}

export const HEALTH_START: HealthState = { health: 'unknown', downSince: null, hardFails: 0 };

export type Evidence =
  /** A sign of life: the link connected, a write went out, the printer answered. */
  | { kind: 'alive' }
  /** The link is down and we know it (a link event, a failed check). Not certain: it may come back at once. */
  | { kind: 'down' }
  /** A failure that says much more: a write failed, a reconnect failed. */
  | { kind: 'failed' }
  /** We closed the link on purpose. */
  | { kind: 'closed' };

/** Feed one piece of evidence. Pure: returns the new state. */
export function observe(state: HealthState, evidence: Evidence, now: number): HealthState {
  switch (evidence.kind) {
    case 'alive':
      // Up is never delayed.
      return { health: 'up', downSince: null, hardFails: 0 };
    case 'closed':
      return HEALTH_START;
    case 'down':
    case 'failed': {
      // Before the first sign of life there is nothing to lose: a failed first connect is a plain failure, not a loss.
      if (state.health === 'unknown') return state;
      const hardFails = evidence.kind === 'failed' ? state.hardFails + 1 : state.hardFails;
      const downSince = state.downSince ?? now;
      if (state.health === 'lost') return { ...state, hardFails };
      if (hardFails >= HARD_FAILS_FOR_LOST) return { health: 'lost', downSince, hardFails };
      return { health: 'wobbling', downSince, hardFails };
    }
  }
}

/** The timer tick. A link that stayed down for the whole grace time is lost. */
export function settle(state: HealthState, now: number): HealthState {
  if (state.health === 'wobbling' && state.downSince !== null && now - state.downSince >= HEALTH_GRACE_MS) {
    return { ...state, health: 'lost' };
  }
  return state;
}

/** Milliseconds until `settle` can change the state, or null when no timer is needed. */
export function settleDelay(state: HealthState, now: number): number | null {
  if (state.health !== 'wobbling' || state.downSince === null) return null;
  return Math.max(0, state.downSince + HEALTH_GRACE_MS - now);
}
