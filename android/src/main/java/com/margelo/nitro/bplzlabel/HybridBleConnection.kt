package com.margelo.nitro.bplzlabel

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
   * A pairing that Android started by itself (the device asked for it when the link opened) and that failed. The device then closes the
   * link (GATT status 19). That close is reported as `E_AUTH`, not as a radio error that is tried again with a new pairing dialog each time.
   */
  private val pairing = PairingWatch()
  private var pairingReceiver: BroadcastReceiver? = null

  /**
   * Does this phone call onCharacteristicWrite for a write without response? Engineers who read the
   * Android source report that it does: BluetoothGatt keeps its busy flag set for every write, also
   * without response, until onCharacteristicWrite. So the normal path waits for the callback.
   * Phones differ and we did not check one, so the first such write is a probe: if no callback comes
   * in PROBE_MS, later pieces are done when Android accepts them. Android's "busy" answer (a refused
   * write, tried again by runOp) is then the flow control. This only protects against a hang.
   */
  @Volatile private var noResponseCallbackSeen: Boolean? = null

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

  override val noResponseCallback: String
    get() = when (noResponseCallbackSeen) {
      true -> "yes"
      false -> "no"
      null -> "unknown"
    }

  override val mtu: Double
    get() = if (mtuValue > DEFAULT_MTU) mtuValue.toDouble() else DEFAULT_MTU.toDouble()

  // ---- connect ----

  /** Start the connection. Resolves `promise` with this object when the link is up. */
  fun open(timeoutMs: Long, promise: Promise<HybridBleConnectionSpec>) {
    connectPromise = promise
    watchPairing()
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

  /** Listen for bond changes of this device while the link lives. A failed pairing is the usual reason for status 19 right after a connect. */
  private fun watchPairing() {
    pairing.reset()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        if (intent?.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return
        val who = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
        if (who?.address != device.address) return
        val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
        val before = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)
        pairing.onBondState(before, state, System.currentTimeMillis())
      }
    }
    try {
      context.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))
      pairingReceiver = receiver
    } catch (_: Exception) {
      // Without the receiver the old behavior stays: the close is reported as a disconnect.
    }
  }

  private fun stopWatchingPairing() {
    val receiver = pairingReceiver ?: return
    pairingReceiver = null
    try {
      context.unregisterReceiver(receiver)
    } catch (_: IllegalArgumentException) {
    }
  }

  /** The error for a link that closed under an operation: `E_AUTH` when a failed pairing closed it, else `E_DISCONNECTED`. */
  private fun closedError(message: String): BleError =
    if (!requestedClose && pairing.closedByFailedPairing(System.currentTimeMillis())) {
      BleError(
        "E_AUTH",
        "The device closed the link after a failed pairing ($message). Remove the old pairing in the phone's Bluetooth settings and try again. " +
          "If it keeps failing, the device may need its own Bluetooth password turned off.",
      )
    } else {
      BleError("E_DISCONNECTED", message)
    }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        connected = true
        wantFastLink(g)
        settleConnect(null)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
        val wasConnected = connected
        connected = false
        guard.abort(DISCONNECTED)
        closeGatt(g)
        if (!wasConnected) {
          // A printer that wants pairing must not be retried like a radio failure: the person has to accept the system dialog.
          val code = if (BleSupport.needsPairing(status) || pairing.closedByFailedPairing(System.currentTimeMillis())) "E_AUTH" else "E_CONNECT"
          settleConnect(BleError(code, "Cannot connect to ${device.address}: ${BleSupport.gattStatusText(status)}"))
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
      guard.complete(status, GattOpGuard.Kind.DISCOVERY)
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) mtuValue = mtu
      guard.complete(status, GattOpGuard.Kind.MTU)
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      guard.complete(status)
    }

    // Android 13 and newer call this one.
    override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
      readValue = value
      guard.complete(status, GattOpGuard.Kind.READ)
    }

    // Android 12 and older call this one.
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        readValue = characteristic.value ?: ByteArray(0)
        guard.complete(status, GattOpGuard.Kind.READ)
      }
    }

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      guard.complete(status, GattOpGuard.Kind.DESCRIPTOR)
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

  @Volatile private var readValue: ByteArray? = null

  private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    val handler = synchronized(subscribers) {
      subscribers[key(characteristic.service.uuid.toString(), characteristic.uuid.toString())]
    }
    handler?.invoke(ArrayBuffer.copy(value))
  }

  private fun notifyDisconnect(reason: String) {
    if (disconnectNotified.compareAndSet(false, true)) onDisconnect(reason)
  }

  /** Close the GATT client. `from` is the object a callback gave us: a failure can arrive before `gatt` is set, and then the field is still null. */
  private fun closeGatt(from: BluetoothGatt? = null) {
    val g = from ?: gatt ?: return
    try {
      g.close()
    } catch (_: Exception) {
    }
    stopWatchingPairing()
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
    probe: Boolean = false,
    kind: GattOpGuard.Kind = GattOpGuard.Kind.WRITE,
    start: () -> Boolean,
  ): Int {
    synchronized(opLock) {
      val deadline = System.currentTimeMillis() + timeoutMs
      while (true) {
        if (!connected) throw closedError("The device is not connected ($what)")
        if (!waitForCallback) {
          // No callback is expected, so there is no operation to guard. Android's "busy" answer is the flow control.
          if (start()) return BluetoothGatt.GATT_SUCCESS
          if (!retryRefusal || System.currentTimeMillis() >= deadline) {
            throw BleError("E_WRITE", "Android refused to start $what (busy or the link is closing)")
          }
          Thread.sleep(RETRY_MS)
          continue
        }
        val op = try {
          guard.begin(kind) // this operation is now the only one that a callback can complete
        } catch (e: IllegalStateException) {
          throw closedError("${e.message} ($what)")
        }
        var accepted = false
        try {
          if (start()) {
            accepted = true
            val status = awaitStatus(op, deadline)
            if (status == null) {
              // Give up this operation BEFORE anything else runs. Its callback may still come. The guard drops it.
              if (probe) guard.abandonTentative(op) else guard.abandon(op, accepted = true)
              throw BleError("E_TIMEOUT", "$what timed out after $timeoutMs ms")
            }
            if (status == DISCONNECTED) throw closedError("The device disconnected during $what")
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

  /**
   * Wait for the callback of `op` until `deadline`. Returns null on a timeout.
   * While a pairing runs, the wait goes on (up to PAIRING_EXTRA_MS more): Android holds a write that the device refused for lack of
   * encryption, starts the pairing and repeats the write itself (BluetoothGatt.onCharacteristicWrite, status 5 or 15), so the app gets
   * no callback until the person has finished the pairing dialog. Not checked on a device.
   */
  private fun awaitStatus(op: GattOpGuard.Op, deadline: Long): Int? {
    var until = deadline
    val hardStop = deadline + PAIRING_EXTRA_MS
    while (true) {
      try {
        return op.future.get(maxOf(until - System.currentTimeMillis(), 1L), TimeUnit.MILLISECONDS)
      } catch (_: TimeoutException) {
        val now = System.currentTimeMillis()
        if (device.bondState != BluetoothDevice.BOND_BONDING || now >= hardStop) return null
        until = minOf(now + BOND_POLL_MS, hardStop)
      }
    }
  }

  // ---- public API ----

  override fun requestMtu(mtu: Double): Promise<Double> {
    val wanted = mtu.toInt().coerceIn(DEFAULT_MTU, MAX_MTU)
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      runOp("MTU request", OP_TIMEOUT_MS, retryRefusal = false, kind = GattOpGuard.Kind.MTU) { g.requestMtu(wanted) }
      mtuValue.toDouble()
    }
  }

  override val bondState: String
    get() = when (device.bondState) {
      BluetoothDevice.BOND_BONDED -> "bonded"
      BluetoothDevice.BOND_BONDING -> "bonding"
      else -> "none"
    }

  /**
   * Pair with the device (createBond) and wait for the result. Nordic's library and Punch Through say to bond only when the device asks
   * for it (an operation failed with status 5, 15 or 137), to wait for the bond result, and then to do the operation again. Some Xiaomi
   * and Samsung phones start pairing only when the app calls createBond. Needs BLUETOOTH_CONNECT on Android 12+ (the connect needed it too).
   */
  override fun bond(timeoutMs: Double): Promise<Boolean> {
    val limit = timeoutMs.toLong().let { if (it > 0) it else BOND_TIMEOUT_MS }
    return Promise.parallel {
      if (device.bondState == BluetoothDevice.BOND_BONDED) return@parallel true
      val finished = CountDownLatch(1)
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
          if (intent?.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return
          val who = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
          if (who?.address != device.address) return
          val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
          val before = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)
          // Done: bonded, or the pairing that was running ended with no bond (the user said no, or it failed).
          if (state == BluetoothDevice.BOND_BONDED || (state == BluetoothDevice.BOND_NONE && before == BluetoothDevice.BOND_BONDING)) finished.countDown()
        }
      }
      context.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))
      try {
        // The stack may have started pairing by itself already. Only start it when it is not running.
        if (device.bondState != BluetoothDevice.BOND_BONDING && !device.createBond()) {
          throw BleError("E_AUTH", "Android could not start pairing with ${device.address}")
        }
        finished.await(limit, TimeUnit.MILLISECONDS)
      } finally {
        try {
          context.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
        }
      }
      device.bondState == BluetoothDevice.BOND_BONDED
    }
  }

  /** Wait until a pairing that is running has ended: discovery during pairing gives wrong results (Nordic skips it while BOND_BONDING). */
  private fun waitWhileBonding() {
    val deadline = System.currentTimeMillis() + BOND_TIMEOUT_MS
    while (device.bondState == BluetoothDevice.BOND_BONDING && System.currentTimeMillis() < deadline && connected) Thread.sleep(BOND_POLL_MS)
  }

  // ---- connection priority: fast while a job sends, balanced when idle ----

  @Volatile private var fastLink = false
  private val backToBalanced = Runnable {
    val g = gatt
    if (g != null && connected) {
      try {
        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
      } catch (_: Exception) {
      }
    }
    fastLink = false
  }

  /**
   * A big label sends many pieces, so the link asks for a short connection interval while it sends. Android's guidance is to use the high
   * priority only to move a lot of data and to go back to balanced afterwards (battery). Every call keeps it fast for FAST_IDLE_MS more.
   */
  private fun wantFastLink(g: BluetoothGatt) {
    main.removeCallbacks(backToBalanced)
    if (!fastLink) {
      try {
        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        fastLink = true
      } catch (_: Exception) {
      }
    }
    main.postDelayed(backToBalanced, FAST_IDLE_MS)
  }

  /** Close at once, without waiting for the callback. Used when a newer connection to the same device replaces this one. */
  internal fun forceClose() {
    requestedClose = true
    main.removeCallbacks(backToBalanced)
    guard.abort(DISCONNECTED)
    try {
      gatt?.disconnect()
    } catch (_: Exception) {
    }
    connected = false
    closeGatt()
    notifyDisconnect("requested")
  }

  override fun discover(): Promise<Array<BleCharacteristic>> {
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      // Android keeps the result of the first discovery. A second call uses it.
      if (g.services.isNullOrEmpty()) {
        waitWhileBonding()
        // Android 7 and older: a bonded device needs time before discovery (Nordic: 1600 ms bonded, 300 ms not). Newer Android does not.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
          Thread.sleep(if (device.bondState == BluetoothDevice.BOND_BONDED) OLD_ANDROID_BONDED_DELAY_MS else OLD_ANDROID_DELAY_MS)
        }
        val status = runOp("service discovery", DISCOVERY_TIMEOUT_MS, kind = GattOpGuard.Kind.DISCOVERY) { g.discoverServices() }
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
      wantFastLink(g)
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
      val status = if (withResponse || noResponseCallbackSeen == true) {
        runOp("write", limit, start = start)
      } else if (noResponseCallbackSeen == false) {
        runOp("write", limit, waitForCallback = false, start = start)
      } else {
        // First write without response: find out whether Android calls back.
        try {
          runOp("write", minOf(limit, PROBE_MS), retryRefusal = true, probe = true, start = start).also { noResponseCallbackSeen = true }
        } catch (e: BleError) {
          if (e.code != "E_TIMEOUT") throw e
          noResponseCallbackSeen = false // accepted by Android, no callback: this phone does not call back
          BluetoothGatt.GATT_SUCCESS
        }
      }
      if (!withResponse && status == GATT_CONGESTED) {
        // Android's stack accepted the data and says its queue is full (att_protocol.cc: "ATT congested, message accepted"). It is not a
        // failure. The next write without response is dropped while the queue is still full, so wait a little first. Not measured.
        Thread.sleep(CONGESTED_WAIT_MS)
        return@parallel
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

  override fun read(serviceUuid: String, characteristicUuid: String): Promise<ArrayBuffer> {
    return Promise.parallel {
      val g = gatt ?: throw BleError("E_DISCONNECTED", "The device is not connected")
      val c = find(g, serviceUuid, characteristicUuid)
      if (c.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0) {
        throw BleError("E_NOT_READABLE", "The characteristic cannot be read")
      }
      readValue = null
      val status = runOp("read", OP_TIMEOUT_MS, kind = GattOpGuard.Kind.READ) { g.readCharacteristic(c) }
      if (status != BluetoothGatt.GATT_SUCCESS) {
        val text = BleSupport.gattStatusText(status)
        if (BleSupport.needsPairing(status)) {
          throw BleError("E_AUTH", "The device needs pairing ($text). Accept the system pairing dialog, then try again.")
        }
        throw BleError("E_READ", "Read failed: $text")
      }
      ArrayBuffer.copy(readValue ?: ByteArray(0))
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
      main.removeCallbacks(backToBalanced)
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
    val status = runOp("notification setup", OP_TIMEOUT_MS, kind = GattOpGuard.Kind.DESCRIPTOR) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        g.writeDescriptor(cccd, value) == 0 // BluetoothStatusCodes.SUCCESS
      } else {
        cccd.value = value
        g.writeDescriptor(cccd)
      }
    }
    if (status != BluetoothGatt.GATT_SUCCESS) {
      val text = BleSupport.gattStatusText(status)
      if (BleSupport.needsPairing(status)) {
        throw BleError("E_AUTH", "The device needs pairing ($text). Accept the system pairing dialog, then try again.")
      }
      throw BleError("E_NOTIFY", "Notification setup failed: $text")
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

    /** GATT_CONGESTED (0x8F): the stack kept a write without response and its queue is full. */
    private const val GATT_CONGESTED = 143
    private const val CONGESTED_WAIT_MS = 100L

    /** How long a write may wait for a pairing that the person is finishing, after its own time limit. */
    private const val PAIRING_EXTRA_MS = 30_000L
    private const val DISCOVERY_TIMEOUT_MS = 15000L
    private const val CLOSE_WAIT_MS = 2000L
    private const val RETRY_MS = 5L
    private const val PROBE_MS = 1000L
    private const val BOND_TIMEOUT_MS = 30_000L
    private const val BOND_POLL_MS = 100L
    private const val FAST_IDLE_MS = 5000L
    private const val OLD_ANDROID_DELAY_MS = 300L
    private const val OLD_ANDROID_BONDED_DELAY_MS = 1600L
    private const val DISCONNECTED = -1
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }
}
