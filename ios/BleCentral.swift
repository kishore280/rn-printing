import CoreBluetooth
import Foundation
import NitroModules
import UIKit

/// An error with a code. TypeScript reads the code in square brackets at the start of the
/// message (see `classify()` in src/transports/bluetoothLE.ts). Nitro passes only the message.
func bleError(_ code: String, _ message: String) -> RuntimeError {
  return RuntimeError.error(withMessage: "[\(code)] \(message)")
}

enum BleSupport {
  private static let baseSuffix = "-0000-1000-8000-00805f9b34fb"
  private static let uuidPattern = try! NSRegularExpression(
    pattern: "^([0-9a-fA-F]{4}|[0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")

  /// `CBUUID(string:)` raises an Objective-C exception for a bad string, so check the text first.
  static func parseUuid(_ text: String) throws -> CBUUID {
    let t = text.trimmingCharacters(in: .whitespaces)
    let range = NSRange(t.startIndex..., in: t)
    guard uuidPattern.firstMatch(in: t, options: [], range: range) != nil else {
      throw bleError("E_BAD_UUID", "Bad UUID: \(text)")
    }
    return CBUUID(string: t)
  }

  /// A lower case 128-bit string, like the Android side.
  static func fullUuid(_ uuid: CBUUID) -> String {
    let hex = uuid.data.map { String(format: "%02x", $0) }.joined()
    switch hex.count {
    case 4: return "0000" + hex + baseSuffix
    case 8: return hex + baseSuffix
    case 32:
      let chars = Array(hex)
      func part(_ from: Int, _ to: Int) -> String { return String(chars[from..<to]) }
      return [part(0, 8), part(8, 12), part(12, 16), part(16, 20), part(20, 32)].joined(separator: "-")
    default: return hex
    }
  }

  static func hex(_ data: Data) -> String {
    return data.map { String(format: "%02x", $0) }.joined()
  }

  static func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "on"
    case .poweredOff: return "off"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    default: return "unknown"
    }
  }

  /// Turn a CoreBluetooth or ATT error into our error, with a code.
  static func mapError(_ error: Error, fallbackCode: String, action: String) -> RuntimeError {
    let ns = error as NSError
    if ns.domain == CBATTErrorDomain {
      switch CBATTError.Code(rawValue: ns.code) {
      case .insufficientAuthentication, .insufficientEncryption, .insufficientAuthorization:
        return bleError("E_AUTH", "The device needs pairing (\(ns.localizedDescription)). Accept the system pairing dialog, then try again.")
      default: break
      }
    }
    if ns.domain == CBErrorDomain, CBError.Code(rawValue: ns.code) == .peerRemovedPairingInformation {
      return bleError("E_AUTH", "The device lost its pairing with this phone. Remove it in iOS Settings > Bluetooth, then try again.")
    }
    return bleError(fallbackCode, "\(action) failed: \(ns.localizedDescription)")
  }
}

/// A promise that settles only once. A second `resolve` or `reject` in Nitro stops the app (fatalError).
final class Settle<T> {
  let promise = Promise<T>()
  private var done = false
  func resolve(_ value: T) {
    if done { return }
    done = true
    promise.resolve(withResult: value)
  }
  func reject(_ error: Error) {
    if done { return }
    done = true
    promise.reject(withError: error)
  }
}

/// The one CBCentralManager of the package. All state is touched on `queue` only.
final class BleCentral: NSObject, CBCentralManagerDelegate {
  static let shared = BleCentral()

  let queue = DispatchQueue(label: "label-printer.ble")
  private let creation = NSLock()
  private var managerStorage: CBCentralManager?

  var stateListener: ((String) -> Void)?
  private var waiters: [(id: Int, body: (Error?) -> Void)] = []
  private var nextWaiter = 0

  // scan
  private var scanSettle: Settle<Void>?
  private var scanOnResult: ((BleScanResult) -> Void)?
  private var scanSeen = Set<UUID>()
  private var scanAllowDuplicates = false
  private var scanToken = 0

  // background: how many times the app went to the background, and the count when each link opened (queue only)
  private var backgroundEntries = 0
  private var linkStartEntries: [UUID: Int] = [:]

  // peripherals
  private var known: [UUID: CBPeripheral] = [:]
  private var connecting: [UUID: (conn: HybridBleConnection, settle: Settle<(any HybridBleConnectionSpec)>)] = [:]
  private var connections: [UUID: HybridBleConnection] = [:]

  override init() {
    super.init()
    // Apple (Core Bluetooth Background Processing): an app without the bluetooth-central background mode is suspended soon after it leaves
    // the foreground, and a link that drops then is reported only when the app runs again. Count the moves to the background, so the
    // reason of a lost link can say it. The package does not hold the app awake: that is the host app's job (docs/BLE.md).
    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async { self?.backgroundEntries += 1 }
    }
  }

  /// Created on first use, so the permission dialog (and, with Bluetooth off, iOS's own "Turn on Bluetooth" alert) appears when the app first uses BLE, not at start-up.
  var manager: CBCentralManager {
    creation.lock()
    defer { creation.unlock() }
    if let m = managerStorage { return m }
    let m = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: true])
    managerStorage = m
    return m
  }

  func currentState() -> String {
    if #available(iOS 13.1, *) {
      let auth = CBCentralManager.authorization
      if auth == .denied || auth == .restricted { return "unauthorized" }
    }
    return BleSupport.stateName(manager.state)
  }

  private func stateError(_ state: CBManagerState) -> Error? {
    switch state {
    case .poweredOn: return nil
    case .poweredOff: return bleError("E_BLUETOOTH_OFF", "Bluetooth is off. Turn it on in Control Center or Settings.")
    case .unauthorized:
      return bleError("E_PERMISSION", "Bluetooth permission is denied. Allow Bluetooth for this app in Settings. The app needs NSBluetoothAlwaysUsageDescription in Info.plist.")
    case .unsupported: return bleError("E_NO_ADAPTER", "This device does not support Bluetooth Low Energy")
    default: return bleError("E_TIMEOUT", "Bluetooth is not ready yet")
    }
  }

  /// Run `body` on the queue when Bluetooth is on. Calls it with an error if Bluetooth is off, denied, or not ready after 10 s.
  func whenReady(_ body: @escaping (Error?) -> Void) {
    queue.async {
      let state = self.manager.state
      if state == .unknown || state == .resetting {
        self.nextWaiter += 1
        let id = self.nextWaiter
        self.waiters.append((id: id, body: body))
        self.queue.asyncAfter(deadline: .now() + 10) {
          if let index = self.waiters.firstIndex(where: { $0.id == id }) {
            let waiter = self.waiters.remove(at: index)
            waiter.body(self.stateError(self.manager.state))
          }
        }
      } else {
        body(self.stateError(state))
      }
    }
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state = central.state
    stateListener?(BleSupport.stateName(state))
    if state != .unknown && state != .resetting {
      let ready = waiters
      waiters.removeAll()
      for waiter in ready { waiter.body(stateError(state)) }
    }
    if state != .poweredOn && state != .unknown && state != .resetting {
      finishScan(error: stateError(state))
      for conn in Array(connections.values) { conn.handleDisconnect(reason: "Bluetooth turned off or became unavailable") }
      for entry in Array(connecting.values) { entry.settle.reject(stateError(state) ?? bleError("E_CONNECT", "Bluetooth is not available")) }
      connecting.removeAll()
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard let onResult = scanOnResult else { return }
    known[peripheral.identifier] = peripheral // CoreBluetooth drops a peripheral nobody holds
    if !scanAllowDuplicates && !scanSeen.insert(peripheral.identifier).inserted { return }
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
    let uuids = ((advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []).map(BleSupport.fullUuid)
    let manufacturer = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data).map(BleSupport.hex) ?? ""
    let connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?? true
    let tx = (advertisementData[CBAdvertisementDataTxPowerLevelKey] as? NSNumber)?.doubleValue
    // 127 means "not available" in CoreBluetooth.
    let rssi: Double? = RSSI.intValue == 127 ? nil : RSSI.doubleValue
    onResult(BleScanResult(id: peripheral.identifier.uuidString, name: name, rssi: rssi, connectable: connectable,
                           serviceUuids: uuids, manufacturerData: manufacturer, txPower: tx))
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard let entry = connecting.removeValue(forKey: peripheral.identifier) else { return }
    connections[peripheral.identifier] = entry.conn
    linkStartEntries[peripheral.identifier] = backgroundEntries
    entry.conn.markConnected()
    entry.settle.resolve(entry.conn)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    guard let entry = connecting.removeValue(forKey: peripheral.identifier) else { return }
    let text = error?.localizedDescription ?? "unknown error"
    entry.settle.reject(bleError("E_CONNECT", "Cannot connect to \(peripheral.identifier.uuidString): \(text)"))
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    // A late event of the link before. A new connect is already running (or done) on the same CBPeripheral, and this
    // event must not end it. Apple: the peripheral's state tells which link is current.
    if peripheral.state == .connecting || peripheral.state == .connected { return }
    var reason = error?.localizedDescription ?? "the device closed the link"
    // The link was open when the app left the foreground. Without the bluetooth-central background mode iOS may have dropped it then.
    if linkStartEntries.removeValue(forKey: peripheral.identifier).map({ $0 != backgroundEntries }) == true {
      reason += " (the app was in the background while the link was open; declare bluetooth-central in UIBackgroundModes)"
    }
    if let entry = connecting.removeValue(forKey: peripheral.identifier) {
      entry.settle.reject(bleError("E_CONNECT", "Cannot connect to \(peripheral.identifier.uuidString): \(reason)"))
    }
    if let conn = connections.removeValue(forKey: peripheral.identifier) {
      conn.handleDisconnect(reason: reason)
    }
  }

  // MARK: Scan

  func startScan(options: BleScanOptions, onResult: @escaping (BleScanResult) -> Void) -> Promise<Void> {
    let settle = Settle<Void>()
    // Check the UUIDs here, because CBUUID(string:) cannot take a bad string.
    let services: [CBUUID]
    do {
      services = try options.serviceUuids.map { try BleSupport.parseUuid($0) }
    } catch {
      settle.reject(error)
      return settle.promise
    }
    whenReady { error in
      if let error = error {
        settle.reject(error)
        return
      }
      self.finishScan(error: nil) // a new scan stops the old one
      self.scanSettle = settle
      self.scanOnResult = onResult
      self.scanSeen = []
      self.scanAllowDuplicates = options.allowDuplicates
      self.scanToken += 1
      let token = self.scanToken
      self.manager.scanForPeripherals(
        withServices: services.isEmpty ? nil : services,
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: options.allowDuplicates])
      if options.timeoutMs > 0 {
        self.queue.asyncAfter(deadline: .now() + options.timeoutMs / 1000.0) {
          if self.scanToken == token { self.finishScan(error: nil) }
        }
      }
    }
    return settle.promise
  }

  func stopScan() -> Promise<Void> {
    queue.async { self.finishScan(error: nil) }
    return Promise<Void>.resolved()
  }

  private func finishScan(error: Error?) {
    guard let settle = scanSettle else { return }
    scanSettle = nil
    scanOnResult = nil
    scanToken += 1
    manager.stopScan()
    if let error = error { settle.reject(error) } else { settle.resolve(()) }
  }

  // MARK: Connect

  func open(deviceId: String, timeoutMs: Double, onDisconnect: @escaping (String) -> Void)
    -> Promise<(any HybridBleConnectionSpec)> {
    let settle = Settle<(any HybridBleConnectionSpec)>()
    guard let uuid = UUID(uuidString: deviceId) else {
      settle.reject(bleError("E_BAD_ADDRESS", "Bad device id: \(deviceId). On iOS it is the UUID from a scan."))
      return settle.promise
    }
    whenReady { error in
      if let error = error {
        settle.reject(error)
        return
      }
      self.finishScan(error: nil) // no scan while connecting
      let peripheral = self.known[uuid] ?? self.manager.retrievePeripherals(withIdentifiers: [uuid]).first
      guard let target = peripheral else {
        // Apple: retrievePeripherals(withIdentifiers:) returns only peripherals the system still knows, and the id is private to this phone.
        // The caller scans again (the transport can do it: option `rediscover`).
        settle.reject(bleError("E_DEVICE_NOT_FOUND", "The id \(deviceId) is not known to this phone (iOS makes ids for each phone, and can forget them). Scan again."))
        return
      }
      self.known[uuid] = target
      // One link per device. A second open ends the first, so no promise is left waiting and no old link stays up
      // (Nordic's BleManager does the same).
      if let older = self.connecting.removeValue(forKey: uuid) {
        older.settle.reject(bleError("E_CONNECT", "Another connect to \(deviceId) started"))
      }
      if let old = self.connections.removeValue(forKey: uuid) {
        old.handleDisconnect(reason: "a new connection was opened")
        self.manager.cancelPeripheralConnection(target)
      }
      let conn = HybridBleConnection(peripheral: target, central: self, onDisconnect: onDisconnect)
      self.connecting[uuid] = (conn: conn, settle: settle)
      self.manager.connect(target, options: nil)
      if timeoutMs > 0 {
        self.queue.asyncAfter(deadline: .now() + timeoutMs / 1000.0) {
          // Only this attempt: a timer of an older attempt must not end a newer one.
          if let entry = self.connecting[uuid], entry.conn === conn {
            self.connecting.removeValue(forKey: uuid)
            self.manager.cancelPeripheralConnection(target)
            entry.settle.reject(bleError("E_TIMEOUT", "No answer from \(deviceId) after \(Int(timeoutMs)) ms. Is the device on and in range?"))
          }
        }
      }
    }
    return settle.promise
  }

  func cancel(_ peripheral: CBPeripheral) {
    manager.cancelPeripheralConnection(peripheral)
  }

  /// Drop the link from the table, but only when it is still the current one for that device.
  func forget(_ conn: HybridBleConnection, _ peripheral: CBPeripheral) {
    if connections[peripheral.identifier] === conn { connections.removeValue(forKey: peripheral.identifier) }
  }
}
