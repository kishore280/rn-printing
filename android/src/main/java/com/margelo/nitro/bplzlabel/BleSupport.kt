package com.margelo.nitro.bplzlabel

import java.util.UUID

/**
 * An error with a code. TypeScript reads the code in square brackets at the start of the
 * message (see `classify()` in src/transports/bluetoothLE.ts). Nitro passes only the message.
 */
class BleError(val code: String, message: String) : Exception("[$code] $message")

internal object BleSupport {
  private const val BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"

  /** Turn a 16-bit, 32-bit or 128-bit UUID string into a lower case 128-bit string. */
  fun fullUuid(text: String): String {
    val t = text.trim().lowercase()
    return when (t.length) {
      4 -> "0000$t$BASE_SUFFIX"
      8 -> "$t$BASE_SUFFIX"
      else -> t
    }
  }

  fun parseUuid(text: String): UUID =
    try {
      UUID.fromString(fullUuid(text))
    } catch (_: IllegalArgumentException) {
      throw BleError("E_BAD_UUID", "Bad UUID: $text")
    }

  fun hex(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) out.append(String.format("%02x", b.toInt() and 0xFF))
    return out.toString()
  }

  /** Text for a GATT status code, from the Android GATT status list. Unknown codes only show the number. */
  fun gattStatusText(status: Int): String {
    val meaning = when (status) {
      0 -> "success"
      5 -> "insufficient authentication (pairing needed)"
      8 -> "connection timeout"
      13 -> "invalid attribute length"
      15 -> "insufficient encryption (pairing needed)"
      19 -> "the device closed the link"
      22 -> "this phone closed the link"
      133 -> "generic error (often: device out of range, busy, or needs a retry)"
      137 -> "authentication failed"
      257 -> "failure"
      else -> null
    }
    return if (meaning == null) "GATT status $status" else "GATT status $status ($meaning)"
  }

  /** Status codes that mean the device wants pairing. The Android stack starts the pairing itself. */
  fun needsPairing(status: Int): Boolean = status == 5 || status == 15 || status == 137
}
