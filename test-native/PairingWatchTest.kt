package com.margelo.nitro.bplzlabel

// Tests for PairingWatch. Plain JVM, no test framework: run by scripts/check-kotlin.sh.

private var passed = 0

private fun check(name: String, condition: Boolean) {
  if (!condition) throw AssertionError("FAILED: $name")
  passed++
}

private const val NONE = PairingWatch.BOND_NONE
private const val BONDING = PairingWatch.BOND_BONDING
private const val BONDED = PairingWatch.BOND_BONDED

fun main() {
  // Nothing happened: a close is a radio error.
  val clean = PairingWatch()
  check("clean: a close is not blamed on pairing", !clean.closedByFailedPairing(1_000))

  // BONDING -> NONE is a failed pairing (the printer's case: it refuses, then closes the link).
  val failed = PairingWatch()
  failed.onBondState(NONE, BONDING, 1_000)
  check("start of pairing is not a failure", !failed.closedByFailedPairing(1_100))
  failed.onBondState(BONDING, NONE, 1_200)
  check("failed pairing, close at once", failed.closedByFailedPairing(1_300))
  check("failed pairing, close at the edge of the window", failed.closedByFailedPairing(1_200 + PairingWatch.WINDOW_MS))
  check("failed pairing, close long after", !failed.closedByFailedPairing(1_200 + PairingWatch.WINDOW_MS + 1))
  check("a clock that goes back is not a match", !failed.closedByFailedPairing(1_100))

  // A pairing that worked clears an earlier failure.
  val recovered = PairingWatch()
  recovered.onBondState(BONDING, NONE, 1_000)
  recovered.onBondState(BONDING, BONDED, 2_000)
  check("a bond clears the failure", !recovered.closedByFailedPairing(2_100))

  // NONE -> NONE and BONDED -> NONE (the bond was removed later) are not failed pairings.
  val removed = PairingWatch()
  removed.onBondState(BONDED, NONE, 1_000)
  removed.onBondState(NONE, NONE, 1_100)
  check("a removed bond is not a failed pairing", !removed.closedByFailedPairing(1_200))

  // A new connection starts clean.
  val again = PairingWatch()
  again.onBondState(BONDING, NONE, 1_000)
  again.reset()
  check("reset forgets the failure", !again.closedByFailedPairing(1_100))

  // The window is a parameter.
  val short = PairingWatch(windowMs = 100)
  short.onBondState(BONDING, NONE, 1_000)
  check("short window: inside", short.closedByFailedPairing(1_100))
  check("short window: outside", !short.closedByFailedPairing(1_101))

  println("PairingWatch: $passed checks passed")
}
