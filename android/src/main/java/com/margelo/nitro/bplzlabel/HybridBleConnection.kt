package com.margelo.nitro.bplzlabel

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.core.Promise
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One GATT link, on top of BluetoothGatt.
 *
 * Android allows ONE pending GATT operation per link. `runOp` takes a lock, starts the
 * operation and waits for its callback (or a timeout). So an operation never starts before
 * the last one has finished. That is the flow control for writes.
 */
@Keep
@DoNotStrip
@Suppress("DEPRECATION", "MissingPermission")
class HybridBleConnection(
  private val context: Context,
  private val device: BluetoothDevice,
  private val onDisconnect: (String) -> Unit,
) : HybridBleConnectionSpec() {
  private val main = Handler(Looper.getMainLooper())
  private val opLock = Any()

  @Volatile private var gatt: BluetoothGatt? = null
  @Volatile private var connected = false
  @Volatile private var mtuValue = DEFAULT_MTU
  private val guard = GattOpGuard()
  @Volatile private var requestedClose = false

  /**
   * Does this phone call onCharacteristicWrite for a write without response? Engineers who read the
   * Android source report that it does: BluetoothGatt keeps its busy flag set for every write, also
   * without response, until onCharacteristicWrite. So the normal path waits for the callback.
   * Phones differ and we did not check one, so the first such write is a probe: if no callback comes
   * in PROBE_MS, later pieces are done when Android accepts them. Android's "busy" answer (a refused
   * write, tried again by runOp) is then the flow control. This only protects against a hang.
   */
  @Volatile private var noResponseCallback: Boolean? = null

  private var connectPromise: Promise<HybridBleConnectionSpec>? = null
  private val connectSettled = AtomicBoolean(false)
  private val disconnectNotified = AtomicBoolean(false)
  private val closed = CountDownLatch(1)
  private val subscribers = HashMap<String, (ArrayBuffer) -> Unit>()

  override val memorySize: Long
    get() = 8192L

  override val id: String
    get() = device.address

  override val isConnected: Boolean
    get() = connected

  override val mtu: Double
    get() = if (mtuValue > DEFAULT_MTU) mtuValue.toDouble() else DEFAULT_MTU.toDouble()

  // ---- connect ----

  /** Start the connection. Resolves `promise` with this object when the link is up. */
  fun open(timeoutMs: Long, promise: Promise<HybridBleConnectionSpec>) {
    connectPromise = promise
    val g = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    } else {
      device.connectGatt(context, false, callback)
    }
    if (g == null) {
      settleConnect(BleError("E_CONNECT", "Android could not start the connection to ${device.address}"))
      return
    }
    gatt = g
    if (timeoutMs > 0) {
      main.postDelayed({
        if (!connected && connectSettled.compareAndSet(false, true)) {
          closeGatt()
          connectPromise?.reject(
            BleError("E_TIMEOUT", "No answer from ${device.address} after $timeoutMs ms. Is the device on and in range?")
          )
        }
      }, timeoutMs)
    }
  }

  private fun settleConnect(error: Throwable?) {
    if (!connectSettled.compareAndSet(false, true)) return
    if (error == null) connectPromise?.resolve(this) else connectPromise?.reject(error)
  }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        connected = true
        try {
          // Faster connection interval. A big label sends many pieces.
          g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        } catch (_: Exception) {
        }
        settleConnect(null)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
        val wasConnected = connected
        connected = false
        guard.abort(DISCONNECTED)
        closeGatt()
        if (!wasConnected) {
          settleConnect(BleError("E_CONNECT", "Cannot connect to ${device.address}: ${BleSupport.gattStatusText(status)}"))
        }
        val reason = when {
          requestedClose -> "requested"
          status == BluetoothGatt.GATT_SUCCESS -> "the device closed the link"
          else -> BleSupport.gattStatusText(status)
        }
        notifyDisconnect(reason)
      }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      guard.complete(status)
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) mtuValue = mtu
      guard.complete(status)
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      guard.complete(status)
    }

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      guard.complete(status)
    }

    // Android 13 and newer call this one.
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      deliver(characteristic, value)
    }

    // Android 12 and older call this one. On 13+ the framework does not call it when the method above is overridden.
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) deliver(characteristic, characteristic.value ?: ByteArray(0))
    }
  }

  private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    val handler = synchronized(subscribers) {
      subscribers[key(characteristic.service.uuid.toString(), characteristic.uuid.toString())]
    }
    handler?.invoke(ArrayBuffer.copy(value))
  }

  private fun notifyDisconnect(reason: String) {
    if (disconnectNotified.compareAndSet(false, true)) onDisconnect(reason)
  }

  private fun closeGatt() {
    val g = gatt ?: return
    try {
      g.close()
    } catch (_: Exception) {
    }
    closed.countDown()
  }

  // ---- one GATT operation at a time ----

  /**
   * Start an operation with `start` (returns false when Android refuses) and wait for its callback.
   * Returns the GATT status. A refusal is tried again for up to `timeoutMs` when `retryRefusal` is true,
   * because Android refuses a new write while the last write without response is still in its queue.
   * An MTU request is not tried again: Android 14 asks for the MTU by itself and refuses a second request.
   */
  private fun runOp(
    what: String,
    timeoutMs: Long,
    retryRefusal: Boolean = true,
    waitForCallback: Boolean = true,
    oweOnTimeout: Boolean = true,
    start: () -> Boolean,
  ): Int {
    synchronized(opLock) {
      val deadline = System.currentTimeMillis() + timeoutMs
      while (true) {
        if (!connected) throw BleError("E_DISCONNECTED", "The device is not connected ($what)")
        val op = try {
          guard.begin() // this operation is now the only one that a callback can complete
        } catch (e: IllegalStateException) {
          throw BleError("E_DISCONNECTED", "${e.message} ($what)")
        }
        var accepted = false
        try {
          if (start()) {
            accepted = true
            if (!waitForCallback) return BluetoothGatt.GATT_SUCCESS
            val left = deadline - System.currentTimeMillis()
            val status = try {
              op.future.get(maxOf(left, 1L), TimeUnit.MILLISECONDS)
            } catch (_: TimeoutException) {
              // Give up this operation BEFORE anything else runs. Its callback may still come. The guard drops it.
              guard.abandon(op, accepted = true, owe = oweOnTimeout)
              throw BleError("E_TIMEOUT", "$what timed out after $timeoutMs ms")
            }
            if (status == DISCONNECTED) throw BleError("E_DISCONNECTED", "The device disconnected during $what")
            return status
          }
        } finally {
          guard.finish(op) // no-op when the operation was given up already
          if (!accepted) guard.abandon(op, accepted = false) // refused by Android: no callback is coming
        }
        if (!retryRefusal || System.currentTimeMillis() >= deadline) {
          throw BleError("E_WRITE", "Android refused to start $what (busy or the link is closing)")
        }
        Thread.sleep(RETRY_MS)
      }
    }
  }

  // ---- public API ----

  override fun requestMtu(mtu: Double): Promise<Double> {
    val wanted = mtu.toInt().coerceIn(DEFAULT_MTU, MAX_MTU)
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      runOp("MTU request", OP_TIMEOUT_MS, retryRefusal = false) { g.requestMtu(wanted) }
      mtuValue.toDouble()
    }
  }

  override fun discover(): Promise<Array<BleCharacteristic>> {
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      // Android keeps the result of the first discovery. A second call uses it.
      if (g.services.isNullOrEmpty()) {
        val status = runOp("service discovery", DISCOVERY_TIMEOUT_MS) { g.discoverServices() }
        if (status != BluetoothGatt.GATT_SUCCESS) {
          throw BleError("E_DISCOVERY", "Service discovery failed: ${BleSupport.gattStatusText(status)}")
        }
      }
      val out = ArrayList<BleCharacteristic>()
      for (service in g.services) {
        for (c in service.characteristics) {
          val p = c.properties
          out.add(
            BleCharacteristic(
              serviceUuid = service.uuid.toString().lowercase(),
              uuid = c.uuid.toString().lowercase(),
              read = p and BluetoothGattCharacteristic.PROPERTY_READ != 0,
              write = p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0,
              writeWithoutResponse = p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0,
              notify = p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0,
              indicate = p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0,
            )
          )
        }
      }
      out.toTypedArray()
    }
  }

  override fun maxWriteLength(withResponse: Boolean): Double {
    val payload = maxOf(mtuValue - ATT_HEADER, DEFAULT_MTU - ATT_HEADER)
    return (if (withResponse) minOf(payload, MAX_ATTRIBUTE) else payload).toDouble()
  }

  override fun write(
    serviceUuid: String,
    characteristicUuid: String,
    data: ArrayBuffer,
    withResponse: Boolean,
    timeoutMs: Double,
  ): Promise<Unit> {
    // The buffer from JS is only valid during this call, so copy the bytes before the work moves to another thread.
    val bytes = ByteArray(data.size)
    data.getBuffer(false).get(bytes)
    val limit = timeoutMs.toLong().let { if (it > 0) it else OP_TIMEOUT_MS }
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      val c = find(g, serviceUuid, characteristicUuid)
      val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      val start = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          g.writeCharacteristic(c, bytes, type) == 0 // BluetoothStatusCodes.SUCCESS
        } else {
          c.writeType = type
          c.value = bytes
          g.writeCharacteristic(c)
        }
      }
      val status = if (withResponse || noResponseCallback == true) {
        runOp("write", limit, start = start)
      } else if (noResponseCallback == false) {
        runOp("write", limit, waitForCallback = false, start = start)
      } else {
        // First write without response: find out whether Android calls back.
        try {
          runOp("write", minOf(limit, PROBE_MS), retryRefusal = true, oweOnTimeout = false, start = start).also { noResponseCallback = true }
        } catch (e: BleError) {
          if (e.code != "E_TIMEOUT") throw e
          noResponseCallback = false // accepted by Android, no callback: this phone does not call back
          BluetoothGatt.GATT_SUCCESS
        }
      }
      if (status != BluetoothGatt.GATT_SUCCESS) {
        val text = BleSupport.gattStatusText(status)
        if (BleSupport.needsPairing(status)) {
          throw BleError("E_AUTH", "The device needs pairing ($text). Accept the system pairing dialog, then try again.")
        }
        throw BleError("E_WRITE", "Write failed: $text")
      }
    }
  }

  override fun subscribe(serviceUuid: String, characteristicUuid: String, onData: (ArrayBuffer) -> Unit): Promise<Unit> {
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      val c = find(g, serviceUuid, characteristicUuid)
      val indicate = c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0 &&
        c.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
      if (c.properties and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) == 0) {
        throw BleError("E_NOTIFY", "The characteristic $characteristicUuid cannot notify")
      }
      synchronized(subscribers) { subscribers[key(serviceUuid, characteristicUuid)] = onData }
      if (!g.setCharacteristicNotification(c, true)) throw BleError("E_NOTIFY", "Android refused notifications for $characteristicUuid")
      val value = if (indicate) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      writeCccd(g, c, value)
    }
  }

  override fun unsubscribe(serviceUuid: String, characteristicUuid: String): Promise<Unit> {
    return Promise.parallel {
      synchronized(subscribers) { subscribers.remove(key(serviceUuid, characteristicUuid)) }
      val g = gatt
      if (g != null && connected) {
        try {
          val c = find(g, serviceUuid, characteristicUuid)
          g.setCharacteristicNotification(c, false)
          writeCccd(g, c, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
        } catch (_: Exception) {
          // The link may be closing. The subscription is gone on our side anyway.
        }
      }
    }
  }

  override fun disconnect(): Promise<Unit> {
    return Promise.parallel {
      requestedClose = true
      guard.abort(DISCONNECTED) // fail a waiting operation now; drop every later callback
      val g = gatt
      if (g != null && !disconnectNotified.get()) {
        try {
          g.disconnect()
        } catch (_: Exception) {
        }
        // The callback closes the GATT object. Wait a short time for it, then force it.
        if (!closed.await(CLOSE_WAIT_MS, TimeUnit.MILLISECONDS)) {
          connected = false
          closeGatt()
          notifyDisconnect("requested")
        }
      }
      synchronized(subscribers) { subscribers.clear() }
    }
  }

  // ---- helpers ----

  private fun writeCccd(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
    val cccd = c.getDescriptor(CCCD) ?: throw BleError("E_NOTIFY", "The characteristic has no notification descriptor")
    val status = runOp("notification setup", OP_TIMEOUT_MS) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        g.writeDescriptor(cccd, value) == 0 // BluetoothStatusCodes.SUCCESS
      } else {
        cccd.value = value
        g.writeDescriptor(cccd)
      }
    }
    if (status != BluetoothGatt.GATT_SUCCESS) {
      throw BleError("E_NOTIFY", "Notification setup failed: ${BleSupport.gattStatusText(status)}")
    }
  }

  private fun find(g: BluetoothGatt, serviceUuid: String, characteristicUuid: String): BluetoothGattCharacteristic {
    val service = g.getService(BleSupport.parseUuid(serviceUuid))
      ?: throw BleError("E_NO_CHARACTERISTIC", "Service $serviceUuid not found on the device")
    return service.getCharacteristic(BleSupport.parseUuid(characteristicUuid))
      ?: throw BleError("E_NO_CHARACTERISTIC", "Characteristic $characteristicUuid not found in service $serviceUuid")
  }

  private fun key(service: String, characteristic: String): String =
    BleSupport.fullUuid(service) + "/" + BleSupport.fullUuid(characteristic)

  companion object {
    private const val DEFAULT_MTU = 23
    private const val MAX_MTU = 517
    private const val ATT_HEADER = 3
    private const val MAX_ATTRIBUTE = 512
    private const val OP_TIMEOUT_MS = 5000L
    private const val DISCOVERY_TIMEOUT_MS = 15000L
    private const val CLOSE_WAIT_MS = 2000L
    private const val RETRY_MS = 5L
    private const val PROBE_MS = 1000L
    private const val DISCONNECTED = -1
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }
}
