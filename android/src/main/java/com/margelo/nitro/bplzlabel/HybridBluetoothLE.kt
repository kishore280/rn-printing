package com.margelo.nitro.bplzlabel

import android.Manifest
import android.app.Activity
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
import com.facebook.react.bridge.BaseActivityEventListener
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
  private val openLinks = HashMap<String, java.lang.ref.WeakReference<HybridBleConnection>>()

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

  override fun requestEnable(): Promise<Boolean> {
    val bt: BluetoothAdapter
    try {
      bt = adapter ?: throw BleError("E_NO_ADAPTER", "This phone has no Bluetooth adapter")
      if (bt.isEnabled) return Promise.resolved(true)
      requireConnectPermission()
    } catch (e: Throwable) {
      return Promise.rejected(e)
    }
    val activity = context.currentActivity
      ?: return Promise.rejected(BleError("E_BLUETOOTH_OFF", "Bluetooth is off, and there is no screen to ask on"))

    val promise = Promise<Boolean>()
    val listener = object : BaseActivityEventListener() {
      override fun onActivityResult(a: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_ENABLE) return
        context.removeActivityEventListener(this)
        if (resultCode != Activity.RESULT_OK) {
          promise.resolve(false) // the user said no
        } else {
          // The user said yes. The adapter needs a moment to be on.
          waitUntilOn(bt, promise, System.currentTimeMillis() + ENABLE_WAIT_MS)
        }
      }
    }
    // The system dialog needs the main thread. It tells the answer to the activity, and the listener hands it on.
    main.post {
      try {
        context.addActivityEventListener(listener)
        activity.startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE)
      } catch (e: Exception) {
        context.removeActivityEventListener(listener)
        promise.reject(BleError("E_BLUETOOTH_OFF", "Bluetooth is off, and the phone could not ask: ${e.message}"))
      }
    }
    return promise
  }

  private fun waitUntilOn(bt: BluetoothAdapter, promise: Promise<Boolean>, deadline: Long) {
    if (bt.isEnabled) promise.resolve(true)
    else if (System.currentTimeMillis() >= deadline) promise.resolve(false)
    else main.postDelayed({ waitUntilOn(bt, promise, deadline) }, ENABLE_POLL_MS)
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
      session.watchAdapter()
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
      // One central per printer: many printers allow only one link. A second connection to the same device (for example an inspect while the
      // print link is open) replaces the older one, and waits a moment after the close (Nordic: 200 ms) before it connects again.
      val older = synchronized(openLinks) { openLinks.remove(deviceId.uppercase())?.get() }
      val link = HybridBleConnection(context, device, onDisconnect)
      synchronized(openLinks) { openLinks[deviceId.uppercase()] = java.lang.ref.WeakReference(link) }
      if (older != null && older.isConnected) {
        older.forceClose()
        main.postDelayed({ link.open(timeoutMs.toLong(), promise) }, CLOSE_SETTLE_MS)
      } else {
        link.open(timeoutMs.toLong(), promise)
      }
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
    } else {
      if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
        throw BleError("E_PERMISSION", "The ACCESS_FINE_LOCATION permission is not granted (needed to scan on Android 11 and older)")
      }
      // Android 11 and older return an empty scan, with no error, while the location switch is off.
      if (!locationIsOn()) throw BleError("E_LOCATION_OFF", "Location is switched off. Android 11 and older need it on to find Bluetooth devices")
    }
  }

  private fun locationIsOn(): Boolean = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      context.getSystemService(android.location.LocationManager::class.java)?.isLocationEnabled ?: true
    } else {
      @Suppress("DEPRECATION")
      android.provider.Settings.Secure.getInt(context.contentResolver, android.provider.Settings.Secure.LOCATION_MODE) != android.provider.Settings.Secure.LOCATION_MODE_OFF
    }
  } catch (_: Exception) {
    true // cannot tell: do not block the scan
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

    // A scan with no time limit would run for ever when Bluetooth goes off: no callback tells it. Watch the adapter while it runs.
    private val adapterWatch = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        if (state == BluetoothAdapter.STATE_OFF || state == BluetoothAdapter.STATE_TURNING_OFF) {
          finish(BleError("E_BLUETOOTH_OFF", "Bluetooth was turned off during the scan"))
        }
      }
    }
    private var watching = false

    fun watchAdapter() {
      try {
        context.registerReceiver(adapterWatch, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
        watching = true
      } catch (_: Exception) {
        // Not fatal: the scan still has its own time limit.
      }
    }

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
        // Android allows 5 scan starts in 30 seconds. Its own code for "too often" is 6 (hidden in older SDKs): a wait helps, so it has its own code.
        val code = if (errorCode == SCAN_FAILED_TOO_FREQUENT) "E_SCAN_THROTTLED" else "E_SCAN_FAILED"
        finish(BleError(code, "Scan failed: ${scanErrorText(errorCode)}"))
      }
    }

    fun finish(error: Throwable?) {
      synchronized(lock) {
        if (done) return
        done = true
        if (scan === this) scan = null
      }
      if (watching) {
        try {
          context.unregisterReceiver(adapterWatch)
        } catch (_: IllegalArgumentException) {
        }
        watching = false
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
    SCAN_FAILED_TOO_FREQUENT -> "scanning too often (Android allows only 5 scan starts in 30 seconds). Wait 30 seconds"
    else -> "error code $code"
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

  companion object {
    /** Request code of the "turn on Bluetooth" dialog. */
    private const val REQUEST_ENABLE = 7421
    private const val ENABLE_WAIT_MS = 5000L
    private const val ENABLE_POLL_MS = 100L

    /** Nordic waits 200 ms between closing a GATT client and the next connectGatt to the same device. */
    private const val CLOSE_SETTLE_MS = 200L

    /** ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY: not a public constant on every SDK. */
    private const val SCAN_FAILED_TOO_FREQUENT = 6
  }
}
