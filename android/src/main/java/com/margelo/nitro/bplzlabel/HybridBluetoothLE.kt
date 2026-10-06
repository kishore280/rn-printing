package com.margelo.nitro.bplzlabel

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise

/**
 * BLE scan and connect with the Android BLE API (BluetoothLeScanner, BluetoothGatt).
 * Nothing here knows about printers.
 */
@Keep
@DoNotStrip
class HybridBluetoothLE : HybridBluetoothLESpec() {
  private val context: ReactApplicationContext
    get() = NitroModules.applicationContext ?: throw Error("No ApplicationContext set!")

  private val adapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private var scan: ScanSession? = null
  private var stateReceiver: BroadcastReceiver? = null

  override val memorySize: Long
    get() = 4096L

  override fun getState(): String {
    val bt = adapter ?: return "unsupported"
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return "unsupported"
    if (!hasConnectPermission()) return "unauthorized"
    return try {
      stateName(bt.state)
    } catch (_: SecurityException) {
      "unauthorized"
    }
  }

  private fun stateName(state: Int): String = when (state) {
    BluetoothAdapter.STATE_ON -> "on"
    BluetoothAdapter.STATE_OFF -> "off"
    else -> "resetting" // turning on or turning off
  }

  override fun setStateListener(listener: (state: String) -> Unit) {
    synchronized(lock) {
      stateReceiver?.let {
        try {
          context.unregisterReceiver(it)
        } catch (_: IllegalArgumentException) {
        }
      }
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
          if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
          listener(stateName(intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)))
        }
      }
      // ACTION_STATE_CHANGED is a system broadcast, so no export flag is needed.
      context.registerReceiver(receiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
      stateReceiver = receiver
    }
    listener(getState())
  }

  override fun scan(options: BleScanOptions, onResult: (result: BleScanResult) -> Unit): Promise<Unit> {
    val scanner: BluetoothLeScanner
    try {
      requireScanPermission()
      scanner = requireAdapter().bluetoothLeScanner ?: throw BleError("E_BLUETOOTH_OFF", "Bluetooth is off")
    } catch (e: Throwable) {
      return Promise.rejected(e)
    }

    val promise = Promise<Unit>()
    val filters: List<ScanFilter>? = if (options.serviceUuids.isEmpty()) null else try {
      options.serviceUuids.map { ScanFilter.Builder().setServiceUuid(ParcelUuid(BleSupport.parseUuid(it))).build() }
    } catch (e: Throwable) {
      return Promise.rejected(e)
    }
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()

    synchronized(lock) {
      scan?.finish(null) // a new scan stops the old one
      val session = ScanSession(scanner, promise, options.allowDuplicates, onResult)
      scan = session
      try {
        scanner.startScan(filters, settings, session.callback)
      } catch (e: SecurityException) {
        scan = null
        return Promise.rejected(BleError("E_PERMISSION", "The Bluetooth scan permission is not granted"))
      } catch (e: IllegalStateException) {
        scan = null
        return Promise.rejected(BleError("E_BLUETOOTH_OFF", "Bluetooth is off"))
      }
      if (options.timeoutMs > 0) main.postDelayed({ session.finish(null) }, options.timeoutMs.toLong())
    }
    return promise
  }

  override fun stopScan(): Promise<Unit> {
    synchronized(lock) { scan?.finish(null) }
    return Promise.resolved(Unit)
  }

  override fun connect(deviceId: String, timeoutMs: Double, onDisconnect: (reason: String) -> Unit): Promise<HybridBleConnectionSpec> {
    val promise = Promise<HybridBleConnectionSpec>()
    try {
      requireConnectPermission()
      val bt = requireAdapter()
      if (!BluetoothAdapter.checkBluetoothAddress(deviceId)) {
        throw BleError("E_BAD_ADDRESS", "Bad Bluetooth address: $deviceId")
      }
      synchronized(lock) { scan?.finish(null) } // Android advises: no scan while connecting
      val device = bt.getRemoteDevice(deviceId)
      HybridBleConnection(context, device, onDisconnect).open(timeoutMs.toLong(), promise)
    } catch (e: Throwable) {
      return Promise.rejected(e)
    }
    return promise
  }

  private fun requireAdapter(): BluetoothAdapter {
    val bt = adapter ?: throw BleError("E_NO_ADAPTER", "This phone has no Bluetooth adapter")
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      throw BleError("E_NO_ADAPTER", "This phone has no Bluetooth Low Energy support")
    }
    if (!bt.isEnabled) throw BleError("E_BLUETOOTH_OFF", "Bluetooth is off")
    return bt
  }

  private fun granted(permission: String): Boolean =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun hasConnectPermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || granted(Manifest.permission.BLUETOOTH_CONNECT)

  private fun requireConnectPermission() {
    if (!hasConnectPermission()) throw BleError("E_PERMISSION", "The BLUETOOTH_CONNECT permission is not granted")
  }

  /** Android 12+: BLUETOOTH_SCAN. Android 11 and older: location. */
  private fun requireScanPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (!granted(Manifest.permission.BLUETOOTH_SCAN)) throw BleError("E_PERMISSION", "The BLUETOOTH_SCAN permission is not granted")
    } else if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
      throw BleError("E_PERMISSION", "The ACCESS_FINE_LOCATION permission is not granted (needed to scan on Android 11 and older)")
    }
  }

  /** One running scan. `finish` is safe to call more than once. */
  private inner class ScanSession(
    private val scanner: BluetoothLeScanner,
    private val promise: Promise<Unit>,
    private val allowDuplicates: Boolean,
    private val onResult: (BleScanResult) -> Unit,
  ) {
    private var done = false
    private val seen = HashSet<String>()

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        if (done) return
        if (!allowDuplicates && !seen.add(result.device.address)) return
        onResult(toResult(result))
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        for (r in results) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, r)
      }

      override fun onScanFailed(errorCode: Int) {
        finish(BleError("E_SCAN_FAILED", "Scan failed: ${scanErrorText(errorCode)}"))
      }
    }

    fun finish(error: Throwable?) {
      synchronized(lock) {
        if (done) return
        done = true
        if (scan === this) scan = null
      }
      try {
        scanner.stopScan(callback)
      } catch (_: Exception) {
        // Bluetooth turned off, or the permission was removed. The scan is over anyway.
      }
      if (error == null) promise.resolve(Unit) else promise.reject(error)
    }
  }

  private fun scanErrorText(code: Int): String = when (code) {
    ScanCallback.SCAN_FAILED_ALREADY_STARTED -> "already started"
    ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "app registration failed"
    ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "BLE scan is not supported on this phone"
    ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "internal error"
    else -> "error code $code (Android allows only 5 scan starts in 30 seconds)"
  }

  private fun toResult(r: ScanResult): BleScanResult {
    val record = r.scanRecord
    val name = record?.deviceName ?: try {
      r.device.name
    } catch (_: SecurityException) {
      null
    }
    val uuids = record?.serviceUuids?.map { it.uuid.toString().lowercase() }?.toTypedArray() ?: emptyArray()
    // Only the first manufacturer block, as on iOS: the 2-byte company id (little endian), then the data.
    var manufacturer = ""
    val blocks = record?.manufacturerSpecificData
    if (blocks != null && blocks.size() > 0) {
      val company = blocks.keyAt(0)
      val data = blocks.valueAt(0) ?: ByteArray(0)
      manufacturer = BleSupport.hex(byteArrayOf((company and 0xFF).toByte(), ((company shr 8) and 0xFF).toByte()) + data)
    }
    val tx = record?.txPowerLevel
    return BleScanResult(
      id = r.device.address,
      name = name ?: "",
      rssi = r.rssi.toDouble(),
      connectable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) r.isConnectable else true,
      serviceUuids = uuids,
      manufacturerData = manufacturer,
      txPower = if (tx == null || tx == Int.MIN_VALUE) null else tx.toDouble(),
    )
  }
}
