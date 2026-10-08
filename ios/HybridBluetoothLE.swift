import Foundation
import NitroModules

/// BLE scan and connect with CoreBluetooth. Nothing here knows about printers.
class HybridBluetoothLE: HybridBluetoothLESpec {
  func getState() throws -> String {
    return BleCentral.shared.currentState()
  }

  func setStateListener(listener: @escaping (_ state: String) -> Void) throws {
    BleCentral.shared.stateListener = listener
    let state = BleCentral.shared.currentState()
    if state != "unknown" { listener(state) }
  }

  /// iOS has no dialog an app can start. With Bluetooth off at the first use, iOS shows its own alert (BleCentral turns it on).
  func requestEnable() throws -> Promise<Bool> {
    return Promise<Bool>.resolved(withResult: BleCentral.shared.currentState() == "on")
  }

  func scan(options: BleScanOptions, onResult: @escaping (_ result: BleScanResult) -> Void) throws -> Promise<Void> {
    return BleCentral.shared.startScan(options: options, onResult: onResult)
  }

  func stopScan() throws -> Promise<Void> {
    return BleCentral.shared.stopScan()
  }

  func connect(deviceId: String, timeoutMs: Double, onDisconnect: @escaping (_ reason: String) -> Void) throws
    -> Promise<(any HybridBleConnectionSpec)> {
    return BleCentral.shared.open(deviceId: deviceId, timeoutMs: timeoutMs, onDisconnect: onDisconnect)
  }
}
