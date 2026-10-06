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

  override val isConnected: Boolean
    get() = !closed && socket.isConnected

  override val memorySize: Long
    get() = 4096L

  override fun write(data: ArrayBuffer, chunkDelayMs: Double): Promise<Unit> {
    // The buffer from JS is only valid during this call, so copy the bytes before the work moves to another thread.
    val bytes = ByteArray(data.size)
    data.getBuffer(false).get(bytes)
    val delayMs = chunkDelayMs.toLong()
    return Promise.parallel {
      check(!closed) { "The connection is closed" }
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
      val piece = ByteArray(CHUNK)
      val start = System.currentTimeMillis()
      var lastData = start
      // Poll like the SNBC SDK does: every 10 ms, and stop after an idle gap once data has come.
      while (System.currentTimeMillis() - start < timeout) {
        val available = input.available()
        if (available > 0) {
          val want = if (limit > 0) minOf(available, piece.size, limit - collected.size()) else minOf(available, piece.size)
          val n = input.read(piece, 0, want)
          if (n > 0) {
            collected.write(piece, 0, n)
            lastData = System.currentTimeMillis()
          }
          if (limit > 0 && collected.size() >= limit) break
        } else {
          if (collected.size() > 0 && System.currentTimeMillis() - lastData >= idle) break
          Thread.sleep(POLL_MS)
        }
      }
      return@parallel ArrayBuffer.copy(collected.toByteArray())
    }
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
    private const val CHUNK = 1024
    private const val POLL_MS = 10L
  }
}
