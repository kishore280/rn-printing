package com.margelo.nitro.bplzlabel

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.util.UUID

@Keep
@DoNotStrip
class HybridClassicBluetooth : HybridClassicBluetoothSpec() {
  private val context: ReactApplicationContext
    get() = NitroModules.applicationContext ?: throw Error("No ApplicationContext set!")

  private val adapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  override fun isEnabled(): Boolean = adapter?.isEnabled == true

  override fun getBondedDevices(): Promise<Array<BondedDevice>> {
    return Promise.parallel {
      requireConnectPermission()
      val bt = adapter ?: throw Error("This phone has no Bluetooth adapter")
      return@parallel bt.bondedDevices.map { BondedDevice(it.name ?: "", it.address) }.toTypedArray()
    }
  }

  override fun connect(address: String, preferInsecure: Boolean): Promise<HybridClassicConnectionSpec> {
    return Promise.parallel {
      requireConnectPermission()
      val bt = adapter ?: throw Error("This phone has no Bluetooth adapter")
      if (!bt.isEnabled) throw Error("Bluetooth is off")
      if (!BluetoothAdapter.checkBluetoothAddress(address)) throw Error("Bad Bluetooth address: $address")
      val device = bt.getRemoteDevice(address)
      val socket = openSocket(bt, device, preferInsecure)
      val connection: HybridClassicConnectionSpec = HybridClassicConnection(socket)
      return@parallel connection
    }
  }

  private fun requireConnectPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val granted = context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    if (!granted) throw Error("The BLUETOOTH_CONNECT permission is not granted")
  }

  /** Secure socket, then insecure socket. A hidden-API socket on channel 1 is the last try. */
  private fun openSocket(bt: BluetoothAdapter, device: BluetoothDevice, preferInsecure: Boolean): BluetoothSocket {
    // Android advises to stop discovery before connect(), because it slows the link.
    // It needs BLUETOOTH_SCAN on Android 12 and newer. We do not ask for it, so a refusal is fine.
    try {
      bt.cancelDiscovery()
    } catch (_: SecurityException) {
    }

    val attempts: List<() -> BluetoothSocket> = listOf(
      { device.createRfcommSocketToServiceRecord(SPP_UUID) },
      { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
      { createChannelOneSocket(device) },
    ).let { if (preferInsecure) listOf(it[1], it[0], it[2]) else it }

    var lastError: Exception? = null
    // One time budget for all tries: a printer that is off must not keep the phone waiting for three blocking connects.
    // `BluetoothSocket.close()` from another thread aborts a connect that blocks (the Android documentation says so).
    val deadline = System.currentTimeMillis() + CONNECT_BUDGET_MS
    for (create in attempts) {
      val left = deadline - System.currentTimeMillis()
      if (left <= 0) {
        lastError = lastError ?: java.io.IOException("timed out after $CONNECT_BUDGET_MS ms")
        break
      }
      var socket: BluetoothSocket? = null
      val watchdog = java.util.Timer("bplz-classic-connect", true)
      try {
        socket = create()
        val opening = socket
        watchdog.schedule(object : java.util.TimerTask() {
          override fun run() {
            try {
              opening.close()
            } catch (_: Exception) {
            }
          }
        }, left)
        socket.connect()
        watchdog.cancel()
        return socket
      } catch (e: Exception) {
        lastError = e
        try {
          socket?.close()
        } catch (_: Exception) {
        }
        // The permission was taken away while the app runs: no other try can work, and the person must fix it (E_PERMISSION, not retried).
        if (e is SecurityException) throw Error("The BLUETOOTH_CONNECT permission is not granted (it was taken away during the connection)")
      } finally {
        watchdog.cancel()
      }
    }
    throw Error("Cannot connect to ${device.address}: ${lastError?.message}")
  }

  private fun createChannelOneSocket(device: BluetoothDevice): BluetoothSocket {
    val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
    return method.invoke(device, 1) as BluetoothSocket
  }

  companion object {
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    /** All tries of one connect() together. Our choice, not measured: long enough for a slow printer, short enough to give an answer. */
    private const val CONNECT_BUDGET_MS = 20_000L
  }
}
