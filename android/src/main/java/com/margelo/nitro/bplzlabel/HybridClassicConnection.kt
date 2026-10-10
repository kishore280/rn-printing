package com.margelo.nitro.bplzlabel

import android.bluetooth.BluetoothSocket
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.core.Promise
import java.io.ByteArrayOutputStream

@Keep
@DoNotStrip
class HybridClassicConnection(private val socket: BluetoothSocket) : HybridClassicConnectionSpec() {
  private val input = socket.inputStream
  private val output = socket.outputStream

  // A write and a read can run at the same time on two pool threads, but two writes must not mix.
  private val writeLock = Any()

  @Volatile
  private var closed = false

  /** The printer closed the connection. Android's `BluetoothSocket.isConnected()` is local state: it changes on our own close() only. */
  @Volatile
  private var peerClosed = false

  /** What the printer sent and nobody read yet. One thread fills it, the read() poll empties it. */
  private val inbox = ByteArrayOutputStream()

  init {
    // A blocking read ends with -1 or an IOException when the printer closes (or when we close). So the state of the link follows from an
    // event, as it does for TCP, and it is known before the next job. The thread ends with the socket.
    Thread({ pump() }, "bplz-classic-reader").apply { isDaemon = true }.start()
  }

  private fun pump() {
    val piece = ByteArray(CHUNK)
    try {
      while (true) {
        val n = input.read(piece)
        if (n < 0) break
        synchronized(inbox) {
          inbox.write(piece, 0, n)
          // A printer that talks and a reader that never comes must not fill the memory: keep the newest bytes (as the BLE inbox does).
          if (inbox.size() > INBOX_LIMIT) {
            val all = inbox.toByteArray()
            inbox.reset()
            inbox.write(all, all.size - INBOX_LIMIT, INBOX_LIMIT)
          }
        }
      }
    } catch (_: java.io.IOException) {
    }
    if (!closed) peerClosed = true
  }

  override val isConnected: Boolean
    get() = !closed && !peerClosed && socket.isConnected

  override val memorySize: Long
    get() = 4096L

  override fun write(data: ArrayBuffer, chunkDelayMs: Double): Promise<Unit> {
    // The buffer from JS is only valid during this call, so copy the bytes before the work moves to another thread.
    val bytes = ByteArray(data.size)
    data.getBuffer(false).get(bytes)
    val delayMs = chunkDelayMs.toLong()
    return Promise.parallel {
      check(!closed) { "The connection is closed" }
      // Nothing has gone out yet: the caller may send this job again on a new connection (the TypeScript side reads this message).
      if (peerClosed) throw Error(PEER_CLOSED_MESSAGE)
      synchronized(writeLock) {
        var offset = 0
        while (offset < bytes.size) {
          val length = minOf(CHUNK, bytes.size - offset)
          output.write(bytes, offset, length)
          offset += length
          if (delayMs > 0 && offset < bytes.size) Thread.sleep(delayMs)
        }
        output.flush()
      }
    }
  }

  override fun read(timeoutMs: Double, idleMs: Double, maxBytes: Double): Promise<ArrayBuffer> {
    val timeout = timeoutMs.toLong()
    val idle = idleMs.toLong()
    val limit = maxBytes.toInt()
    return Promise.parallel {
      check(!closed) { "The connection is closed" }
      val collected = ByteArrayOutputStream()
      val start = System.currentTimeMillis()
      var lastData = start
      // Poll the inbox like the SNBC SDK polls the stream: every 10 ms, and stop after an idle gap once data has come.
      while (System.currentTimeMillis() - start < timeout) {
        val taken = takeFromInbox(if (limit > 0) limit - collected.size() else Int.MAX_VALUE)
        if (taken.isNotEmpty()) {
          collected.write(taken, 0, taken.size)
          lastData = System.currentTimeMillis()
          if (limit > 0 && collected.size() >= limit) break
        } else {
          if (collected.size() > 0 && System.currentTimeMillis() - lastData >= idle) break
          if (peerClosed) break // nothing more will come
          Thread.sleep(POLL_MS)
        }
      }
      return@parallel ArrayBuffer.copy(collected.toByteArray())
    }
  }

  /** Up to `max` bytes from the inbox. */
  private fun takeFromInbox(max: Int): ByteArray = synchronized(inbox) {
    val all = inbox.toByteArray()
    val n = minOf(all.size, max)
    inbox.reset()
    if (n < all.size) inbox.write(all, n, all.size - n)
    all.copyOf(n)
  }

  override fun close(): Promise<Unit> {
    return Promise.parallel {
      if (!closed) {
        closed = true
        try {
          socket.close()
        } catch (_: Exception) {
        }
      }
    }
  }

  companion object {
    /** The words TypeScript maps to E_DISCONNECTED with nothing sent (`bluetoothClassic.ts`): change both together. */
    const val PEER_CLOSED_MESSAGE = "The printer had closed the connection before this write (nothing was sent)"
    private const val INBOX_LIMIT = 64 * 1024
    private const val CHUNK = 1024
    private const val POLL_MS = 10L
  }
}
