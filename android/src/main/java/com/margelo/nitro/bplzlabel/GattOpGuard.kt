package com.margelo.nitro.bplzlabel

import java.util.concurrent.CompletableFuture

/**
 * Tells which GATT operation a callback belongs to. No Android classes are used here, so the rules can be tested on a JVM.
 *
 * Android GATT callbacks carry no operation id, and Android runs one operation at a time. So the guard keeps:
 * - `active`: the one operation that waits for a callback now. Each operation has its own token (`Op`).
 * - `owed`: how many callbacks are still to come from operations that were given up (timeout, cancel) after Android
 *   accepted them. Android answers in order, so these callbacks come first. They are dropped and never reach a newer operation.
 * After `abort` (disconnect) the guard is closed: every callback is dropped.
 */
internal class GattOpGuard {
  class Op(val id: Long) {
    val future = CompletableFuture<Int>()
  }

  private val lock = Any()
  private var next = 0L
  private var active: Op? = null
  private var owed = 0
  private var closed = false

  /** Start an operation and make it the active one. Fails when another one is active or the guard is closed. */
  fun begin(): Op = synchronized(lock) {
    check(!closed) { "The GATT link is closed" }
    check(active == null) { "A GATT operation is already active" }
    Op(++next).also { active = it }
  }

  /** A callback arrived. Returns true only when it completed the active operation. */
  fun complete(status: Int): Boolean {
    val op = synchronized(lock) {
      if (closed) return false
      if (owed > 0) { // it belongs to an operation that was given up
        owed--
        return false
      }
      val current = active ?: return false // nothing waits: a duplicate or a stray callback
      active = null // an operation can complete only once
      current
    }
    op.future.complete(status)
    return true
  }

  /**
   * Give up `op` (timeout, cancel, refused start or failure). It stops being active at once.
   * When Android had accepted it (`accepted`), its callback may still come, and it is dropped when it does.
   * Pass `owe = false` when no callback is expected (a phone that never calls back).
   */
  fun abandon(op: Op, accepted: Boolean, owe: Boolean = true) = synchronized(lock) {
    if (active === op) active = null
    if (accepted && owe && !closed) owed++
  }

  /** The operation is done. Make sure it is not active any more. */
  fun finish(op: Op) = synchronized(lock) {
    if (active === op) active = null
  }

  /** The link is gone (disconnect). Fail the active operation with `status` and drop every later callback. */
  fun abort(status: Int) {
    val op = synchronized(lock) {
      closed = true
      owed = 0
      active.also { active = null }
    }
    op?.future?.complete(status)
  }
}
