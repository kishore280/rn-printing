package com.margelo.nitro.bplzlabel

/**
 * Remembers that a pairing failed while a link was open. Plain Kotlin, no Android classes: the JVM test in `test-native/` runs it.
 *
 * Some devices ask for pairing the moment the link opens (the Android stack starts it by itself, the app never calls `createBond`).
 * When the pairing fails, the device closes the link at once with GATT status 19. Without this, the app sees "the device
 * disconnected" (`E_DISCONNECTED`, a radio error that is tried again), and every try opens a new pairing dialog. With this, the same
 * close is reported as `E_AUTH`, which is not tried again: the person must fix the pairing (or the device's own password setting).
 */
class PairingWatch(private val windowMs: Long = WINDOW_MS) {
  @Volatile private var failedAtMs = 0L

  /** A bond state change of this device. Android constants: BOND_NONE 10, BOND_BONDING 11, BOND_BONDED 12. */
  fun onBondState(previous: Int, state: Int, nowMs: Long) {
    if (previous == BOND_BONDING && state == BOND_NONE) failedAtMs = nowMs
    if (state == BOND_BONDED) failedAtMs = 0L
  }

  /** True when a pairing failed no longer than `windowMs` before `nowMs`: a close now was most likely caused by it. */
  fun closedByFailedPairing(nowMs: Long): Boolean {
    val at = failedAtMs
    return at > 0L && nowMs >= at && nowMs - at <= windowMs
  }

  /** Forget a failure (a new connection starts clean). */
  fun reset() {
    failedAtMs = 0L
  }

  companion object {
    const val BOND_NONE = 10
    const val BOND_BONDING = 11
    const val BOND_BONDED = 12

    /** The printer closes the link within a few seconds of the failed pairing (seen: under 1 s). */
    const val WINDOW_MS = 15_000L
  }
}
