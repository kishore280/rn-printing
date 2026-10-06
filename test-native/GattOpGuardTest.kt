package com.margelo.nitro.bplzlabel

import java.util.concurrent.TimeUnit

// Race tests for GattOpGuard. Plain JVM, no test framework: run by scripts/check-kotlin.sh.
// A "late callback" is a callback that Android sends after the operation was given up.

private var passed = 0

private fun check(name: String, condition: Boolean) {
  if (!condition) throw AssertionError("FAILED: $name")
  passed++
}

private fun done(op: GattOpGuard.Op) = op.future.isDone
private fun value(op: GattOpGuard.Op) = op.future.get(0, TimeUnit.MILLISECONDS)

private fun testA() {
  // write A starts, A times out, write B starts, late callback for A arrives -> B must NOT complete
  val g = GattOpGuard()
  val a = g.begin()
  g.abandon(a, accepted = true) // timeout
  val b = g.begin()
  check("A: late callback of A is dropped", !g.complete(133))
  check("A: B is not completed by the late callback", !done(b))
  check("A: A is not completed either", !done(a))
  check("A: the real callback of B completes B", g.complete(0))
  check("A: B has its own status", value(b) == 0)
}

private fun testB() {
  // write A starts, A is cancelled, late callback for A arrives -> callback ignored
  val g = GattOpGuard()
  val a = g.begin()
  g.abandon(a, accepted = true) // cancel
  check("B: late callback is ignored", !g.complete(0))
  check("B: A stays not completed", !done(a))
  val b = g.begin() // the next operation starts clean
  check("B: next operation completes on its own callback", g.complete(0) && done(b))
}

private fun testC() {
  // write A starts, disconnect occurs, late callback arrives -> callback ignored
  val g = GattOpGuard()
  val a = g.begin()
  g.abort(-1) // disconnect
  check("C: the waiting operation fails with the disconnect status", done(a) && value(a) == -1)
  check("C: late callback is ignored", !g.complete(0))
  check("C: value of A did not change", value(a) == -1)
  var refused = false
  try { g.begin() } catch (_: IllegalStateException) { refused = true }
  check("C: no new operation can start on a closed link", refused)
}

private fun testD() {
  // normal write callback -> operation completes exactly once
  val g = GattOpGuard()
  val a = g.begin()
  check("D: the callback completes the active operation", g.complete(0))
  check("D: status is delivered", done(a) && value(a) == 0)
  g.finish(a)
  val b = g.begin() // a new operation can follow
  check("D: the next operation is not completed by the old callback", !done(b))
}

private fun testE() {
  // duplicate callback for the same completed operation -> second callback ignored
  val g = GattOpGuard()
  val a = g.begin()
  check("E: first callback completes", g.complete(0))
  check("E: second callback is ignored", !g.complete(5))
  check("E: status stays the first one", value(a) == 0)
}

private fun testMore() {
  // Two operations given up, then one real: both late callbacks are dropped in order.
  val g = GattOpGuard()
  g.abandon(g.begin(), accepted = true)
  g.abandon(g.begin(), accepted = true)
  val c = g.begin()
  check("more: first late callback dropped", !g.complete(1))
  check("more: second late callback dropped", !g.complete(2))
  check("more: third callback is the real one", g.complete(0) && value(c) == 0)

  // An operation that Android refused will never call back: nothing is owed.
  val h = GattOpGuard()
  h.abandon(h.begin(), accepted = false)
  val d = h.begin()
  check("more: a refused operation owes no callback", h.complete(0) && value(d) == 0)

  // A phone that never calls back (probe): no callback is owed.
  val k = GattOpGuard()
  k.abandon(k.begin(), accepted = true, owe = false)
  val e = k.begin()
  check("more: owe=false owes nothing", k.complete(0) && value(e) == 0)

  // Only one operation can be active.
  val m = GattOpGuard()
  m.begin()
  var refused = false
  try { m.begin() } catch (_: IllegalStateException) { refused = true }
  check("more: a second active operation is refused", refused)

  // A stray callback with nothing waiting is ignored.
  check("more: stray callback ignored", !GattOpGuard().complete(0))
}

fun main() {
  testA(); testB(); testC(); testD(); testE(); testMore()
  println("GattOpGuard: $passed checks passed")
}
