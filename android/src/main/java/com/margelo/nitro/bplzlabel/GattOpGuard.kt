package com.margelo.nitro.bplzlabel

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Tells which GATT operation a callback belongs to. No Android classes are used here, so the rules can be tested on a JVM.
 *
 * Android GATT callbacks carry no operation id, and Android runs one operation at a time. So the guard keeps:
 * - `active`: the one operation that waits for a callback now. Each operation has its own token (`Op`).
 * - `owed`: how many callbacks are still to come from operations that were given up (timeout, cancel) after Android
 *   accepted them. Android answers in order, so these callbacks come first. They are dropped and never reach a newer operation.
 * - `tentativeUntil`: set when the first write without response (the probe) timed out. A callback may still come, or the phone
 *   may never call back. Until it comes or `tentativeWindowMs` pass, the next callback is dropped, and `begin()` waits.
 *   So a late probe callback can never complete a later operation, and a phone that never calls back loses nothing
 *   except a short wait for an operation that needs a callback.
 * - Each operation has a kind (MTU, discovery, write, read, descriptor) and each callback has the kind of the Android call it answers.
 *   A callback whose kind is not the active operation's kind is dropped. Android 14 and newer start an MTU exchange by themselves
 *   after the connect, and their `onMtuChanged` must never complete a discovery or a write that is waiting
 *   (found by an audit against Nordic's library, which keeps one request per operation). `owed` keeps the kinds in order.
 * After `abort` (disconnect) the guard is closed: every callback is dropped.
 */
internal class GattOpGuard(private val tentativeWindowMs: Long = 2000L) {
  enum class Kind { MTU, DISCOVERY, WRITE, READ, DESCRIPTOR }

  class Op(val id: Long, val kind: Kind) {
    val future = CompletableFuture<Int>()
  }

  private val lock = ReentrantLock()
  private val settled = lock.newCondition()
  private var next = 0L
  private var active: Op? = null
  private val owed = ArrayDeque<Kind>()
  private var closed = false
  private var tentativeUntil = 0L // System.nanoTime() value, 0 = none

  private fun tentative(): Boolean = tentativeUntil != 0L && System.nanoTime() - tentativeUntil < 0

  private fun clearTentative() {
    tentativeUntil = 0L
    settled.signalAll()
  }

  /**
   * Start an operation and make it the active one. Fails when another one is active or the guard is closed.
   * While a probe callback is still possible, it waits (at most `tentativeWindowMs`) until that callback came or the window ended.
   */
  fun begin(kind: Kind = Kind.WRITE): Op = lock.withLock {
    while (!closed && tentative()) settled.awaitNanos(maxOf(tentativeUntil - System.nanoTime(), 1L))
    check(!closed) { "The GATT link is closed" }
    check(active == null) { "A GATT operation is already active" }
    Op(++next, kind).also { active = it }
  }

  /** A callback arrived. Returns true only when it completed the active operation. */
  fun complete(status: Int, kind: Kind = Kind.WRITE): Boolean {
    val op = lock.withLock {
      if (closed) return false
      if (kind == Kind.WRITE && tentative()) { // the late callback of the probe: the oldest one, so it comes first
        clearTentative()
        return false
      }
      if (owed.firstOrNull() == kind) { // it belongs to an operation that was given up
        owed.removeFirst()
        return false
      }
      val current = active ?: return false // nothing waits: a duplicate or a stray callback
      if (current.kind != kind) return false // another kind of callback (Android's own MTU exchange): not ours
      active = null // an operation can complete only once
      current
    }
    op.future.complete(status)
    return true
  }

  /**
   * Give up `op` (timeout, cancel, refused start or failure). It stops being active at once.
   * When Android had accepted it (`accepted`), its callback may still come, and it is dropped when it does.
   */
  fun abandon(op: Op, accepted: Boolean) = lock.withLock {
    if (active === op) active = null
    if (accepted && !closed) owed.addLast(op.kind)
  }

  /**
   * Give up the probe (the first write without response) after a timeout. Android accepted it. A callback may come later, or never.
   * It is dropped when it comes within the window. Nothing is owed after the window.
   */
  fun abandonTentative(op: Op) = lock.withLock {
    if (active === op) active = null
    if (!closed) tentativeUntil = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(tentativeWindowMs)
  }

  /** The operation is done. Make sure it is not active any more. */
  fun finish(op: Op) = lock.withLock {
    if (active === op) active = null
  }

  /** The link is gone (disconnect). Fail the active operation with `status` and drop every later callback. */
  fun abort(status: Int) {
    val op = lock.withLock {
      closed = true
      owed.clear()
      clearTentative()
      active.also { active = null }
    }
    op?.future?.complete(status)
  }
}
