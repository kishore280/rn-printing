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

private fun testMtuKind() {
  // Android 14 starts its own MTU exchange: its callback must not complete a waiting discovery or write
  val g = GattOpGuard()
  val d = g.begin(GattOpGuard.Kind.DISCOVERY)
  check("K: an MTU callback does not complete a discovery", !g.complete(0, GattOpGuard.Kind.MTU) && !done(d))
  check("K: the discovery callback completes it", g.complete(0, GattOpGuard.Kind.DISCOVERY) && done(d))
  val w = g.begin(GattOpGuard.Kind.WRITE)
  check("K: an MTU callback does not complete a write", !g.complete(0, GattOpGuard.Kind.MTU) && !done(w))
  check("K: the write callback completes it", g.complete(0, GattOpGuard.Kind.WRITE) && done(w))
  val m = g.begin(GattOpGuard.Kind.MTU)
  check("K: our own MTU request is completed by the MTU callback", g.complete(0, GattOpGuard.Kind.MTU) && done(m))
}

private fun testOwedKind() {
  // a given-up discovery is owed one DISCOVERY callback; an unsolicited MTU callback must not use it up
  val g = GattOpGuard()
  val a = g.begin(GattOpGuard.Kind.DISCOVERY)
  g.abandon(a, accepted = true)
  val b = g.begin(GattOpGuard.Kind.READ)
  check("O: an MTU callback is dropped and keeps the debt", !g.complete(0, GattOpGuard.Kind.MTU) && !done(b))
  check("O: the late discovery callback is dropped", !g.complete(0, GattOpGuard.Kind.DISCOVERY) && !done(b))
  check("O: the read callback completes the read", g.complete(0, GattOpGuard.Kind.READ) && done(b))
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


  // Only one operation can be active.
  val m = GattOpGuard()
  m.begin()
  var refused = false
  try { m.begin() } catch (_: IllegalStateException) { refused = true }
  check("more: a second active operation is refused", refused)

  // A stray callback with nothing waiting is ignored.
  check("more: stray callback ignored", !GattOpGuard().complete(0))
}

private fun testProbe() {
  // probe starts -> accepted -> times out -> next write starts -> late probe callback arrives -> must NOT affect the next write
  val g = GattOpGuard(tentativeWindowMs = 1000)
  val probe = g.begin()
  g.abandonTentative(probe) // the probe timed out
  var next: GattOpGuard.Op? = null
  val starter = Thread { next = g.begin() } // the next write that needs a callback starts now
  starter.start()
  Thread.sleep(100)
  check("probe: the next operation waits while the probe callback is still possible", next == null)
  check("probe: the late probe callback is dropped", !g.complete(0))
  starter.join(2000)
  val b = next ?: throw AssertionError("FAILED: probe: next operation did not start after the late callback")
  check("probe: the next operation was NOT completed by the late probe callback", !done(b))
  check("probe: the probe is not completed either", !done(probe))
  check("probe: the real callback of the next operation completes it", g.complete(0) && value(b) == 0)
  check("probe: and a duplicate is ignored", !g.complete(0))
}

private fun testProbeNeverCallsBack() {
  // The phone never calls back for a write without response: the window ends, nothing is lost.
  val g = GattOpGuard(tentativeWindowMs = 150)
  g.abandonTentative(g.begin())
  val started = System.nanoTime()
  val b = g.begin() // waits for the window, then starts
  val waitedMs = (System.nanoTime() - started) / 1_000_000
  check("probe-never: the wait is bounded by the window", waitedMs in 100..1500)
  check("probe-never: the real callback of the next operation is not lost", g.complete(0) && value(b) == 0)
}

private fun testProbeThenDisconnect() {
  val g = GattOpGuard(tentativeWindowMs = 5000)
  g.abandonTentative(g.begin())
  var failed: Throwable? = null
  val t = Thread { try { g.begin() } catch (e: IllegalStateException) { failed = e } }
  t.start()
  Thread.sleep(50)
  g.abort(-1) // disconnect while the next write waits
  t.join(2000)
  check("probe-disconnect: a waiting operation ends at disconnect", failed != null && !t.isAlive)
  check("probe-disconnect: late callback ignored", !g.complete(0))
}

fun main() {
  testA(); testB(); testC(); testD(); testE(); testMore(); testProbe(); testProbeNeverCallsBack(); testProbeThenDisconnect(); testMtuKind(); testOwedKind()
  println("GattOpGuard: $passed checks passed")
}
