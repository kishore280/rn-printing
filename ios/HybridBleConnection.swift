import CoreBluetooth
import Foundation
import NitroModules

/// One queued write. A write goes out only after the one before it has finished.
private final class WriteJob {
  let characteristic: CBCharacteristic
  let data: Data
  let withResponse: Bool
  let settle: Settle<Void>
  let limitMs: Double
  /// The write was sent and waits for its response (with response only).
  var started = false
  /// The job reached the head of the queue. Its time limit runs from here, not from the call.
  var began = false
  init(characteristic: CBCharacteristic, data: Data, withResponse: Bool, limitMs: Double, settle: Settle<Void>) {
    self.characteristic = characteristic
    self.data = data
    self.withResponse = withResponse
    self.limitMs = limitMs
    self.settle = settle
  }
}

/// CoreBluetooth calls a delegate that is an NSObject. HybridObject is not one, so this small class forwards the calls.
private final class PeripheralForwarder: NSObject, CBPeripheralDelegate {
  weak var owner: HybridBleConnection?

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    owner?.didDiscoverServices(error)
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    owner?.didDiscoverCharacteristics(for: service, error: error)
  }
  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    owner?.didWrite(characteristic, error: error)
  }
  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    owner?.pump()
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    owner?.didUpdateNotificationState(characteristic, error: error)
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    owner?.didUpdateValue(characteristic, error: error)
  }
}

/// One GATT link, on top of CBPeripheral. All state is touched on the central's queue only.
class HybridBleConnection: HybridBleConnectionSpec {
  private let peripheral: CBPeripheral
  private let central: BleCentral
  private let onDisconnect: (String) -> Void
  private let forwarder = PeripheralForwarder()
  private var queue: DispatchQueue { return central.queue }

  private var connected = false
  private var requestedClose = false
  private var disconnectNotified = false
  private var disconnectWaiters: [Settle<Void>] = []

  private var discovery: Settle<[BleCharacteristic]>?
  private var servicesToDiscover = 0
  private var writes: [WriteJob] = []
  /// Responses still owed to writes that timed out. CoreBluetooth answers in order, so the next didWrite is theirs.
  private var staleResponses = 0
  private var notifyWaiters: [CBCharacteristic: Settle<Void>] = [:]
  private var subscribers: [String: (ArrayBuffer) -> Void] = [:]
  private var readWaiters: [CBCharacteristic: Settle<ArrayBuffer>] = [:]

  init(peripheral: CBPeripheral, central: BleCentral, onDisconnect: @escaping (String) -> Void) {
    self.peripheral = peripheral
    self.central = central
    self.onDisconnect = onDisconnect
    super.init()
    forwarder.owner = self
    peripheral.delegate = forwarder
  }

  var id: String { return peripheral.identifier.uuidString }

  var isConnected: Bool { return connected }

  /// iOS has no callback after a write without response: it uses canSendWriteWithoutResponse.
  var noResponseCallback: String { return "not applicable" }

  /// iOS does not tell the MTU. The largest write without response is the MTU minus 3.
  var mtu: Double { return Double(peripheral.maximumWriteValueLength(for: .withoutResponse) + 3) }

  func markConnected() {
    connected = true
  }

  // MARK: Public API

  func requestMtu(mtu: Double) throws -> Promise<Double> {
    // iOS negotiates the MTU by itself and has no API to ask for a size.
    return Promise<Double>.resolved(withResult: self.mtu)
  }

  /// A write with response may be larger (iOS uses long writes), but a printer that takes small packets may not take them.
  /// Use the smaller of the two, so one piece size is safe in both modes (Apple: maximumWriteValueLength(for:)).
  func maxWriteLength(withResponse: Bool) throws -> Double {
    let without = peripheral.maximumWriteValueLength(for: .withoutResponse)
    if !withResponse { return Double(without) }
    return Double(min(peripheral.maximumWriteValueLength(for: .withResponse), without))
  }

  /// iOS has no API to pair. The system pairs by itself when a read, write or subscribe needs encryption
  /// (and shows its own dialog). A failure comes back as an authentication error, which BleSupport.mapError maps to E_AUTH.
  var bondState: String { return "unknown" }

  func bond(timeoutMs: Double) throws -> Promise<Bool> {
    // Nothing to start. The caller then repeats its operation, and iOS asks the user to pair if it must.
    return Promise<Bool>.resolved(withResult: true)
  }

  func discover() throws -> Promise<[BleCharacteristic]> {
    let settle = Settle<[BleCharacteristic]>()
    queue.async {
      guard self.connected else {
        settle.reject(bleError("E_DISCONNECTED", "The device is not connected"))
        return
      }
      if let old = self.discovery {
        old.reject(bleError("E_DISCOVERY", "Another discovery started"))
      }
      self.discovery = settle
      self.peripheral.discoverServices(nil)
      self.queue.asyncAfter(deadline: .now() + 15) {
        if self.discovery === settle {
          self.discovery = nil
          settle.reject(bleError("E_TIMEOUT", "service discovery timed out after 15000 ms"))
        }
      }
    }
    return settle.promise
  }

  func write(serviceUuid: String, characteristicUuid: String, data: ArrayBuffer, withResponse: Bool,
             timeoutMs: Double) throws -> Promise<Void> {
    // The buffer from JS is only valid during this call, so copy the bytes before the work moves to the queue.
    let bytes = data.toData(copyIfNeeded: true)
    let settle = Settle<Void>()
    let limit = timeoutMs > 0 ? timeoutMs : 5000
    queue.async {
      do {
        let characteristic = try self.find(serviceUuid, characteristicUuid)
        guard self.connected else { throw bleError("E_DISCONNECTED", "The device is not connected") }
        let job = WriteJob(characteristic: characteristic, data: bytes, withResponse: withResponse, limitMs: limit, settle: settle)
        self.writes.append(job)
        self.pump()
      } catch {
        settle.reject(error)
      }
    }
    return settle.promise
  }

  func read(serviceUuid: String, characteristicUuid: String) throws -> Promise<ArrayBuffer> {
    let settle = Settle<ArrayBuffer>()
    queue.async {
      do {
        guard self.connected else { throw bleError("E_DISCONNECTED", "The device is not connected") }
        let characteristic = try self.find(serviceUuid, characteristicUuid)
        guard characteristic.properties.contains(.read) else {
          throw bleError("E_NOT_READABLE", "The characteristic cannot be read")
        }
        if let old = self.readWaiters.removeValue(forKey: characteristic) {
          old.reject(bleError("E_READ", "Another read started"))
        }
        self.readWaiters[characteristic] = settle
        self.peripheral.readValue(for: characteristic)
        self.queue.asyncAfter(deadline: .now() + 5) {
          if let waiter = self.readWaiters[characteristic], waiter === settle {
            self.readWaiters.removeValue(forKey: characteristic)
            settle.reject(bleError("E_TIMEOUT", "read timed out after 5000 ms"))
          }
        }
      } catch {
        settle.reject(error)
      }
    }
    return settle.promise
  }

  func subscribe(serviceUuid: String, characteristicUuid: String, onData: @escaping (_ data: ArrayBuffer) -> Void) throws
    -> Promise<Void> {
    let settle = Settle<Void>()
    queue.async {
      do {
        guard self.connected else { throw bleError("E_DISCONNECTED", "The device is not connected") }
        let characteristic = try self.find(serviceUuid, characteristicUuid)
        guard characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) else {
          throw bleError("E_NOTIFY", "The characteristic \(characteristicUuid) cannot notify")
        }
        self.subscribers[self.key(characteristic)] = onData
        self.notifyWaiters[characteristic] = settle
        self.peripheral.setNotifyValue(true, for: characteristic)
        self.queue.asyncAfter(deadline: .now() + 5) {
          if let waiter = self.notifyWaiters.removeValue(forKey: characteristic) {
            waiter.reject(bleError("E_TIMEOUT", "notification setup timed out after 5000 ms"))
          }
        }
      } catch {
        settle.reject(error)
      }
    }
    return settle.promise
  }

  func unsubscribe(serviceUuid: String, characteristicUuid: String) throws -> Promise<Void> {
    queue.async {
      if let characteristic = try? self.find(serviceUuid, characteristicUuid) {
        self.subscribers.removeValue(forKey: self.key(characteristic))
        if self.connected { self.peripheral.setNotifyValue(false, for: characteristic) }
      }
    }
    return Promise<Void>.resolved()
  }

  func disconnect() throws -> Promise<Void> {
    let settle = Settle<Void>()
    queue.async {
      if !self.connected {
        settle.resolve(())
        return
      }
      self.requestedClose = true
      self.disconnectWaiters.append(settle)
      self.central.cancel(self.peripheral)
      // If iOS does not answer, end the link on our side after 2 s.
      self.queue.asyncAfter(deadline: .now() + 2) {
        if self.connected { self.handleDisconnect(reason: "requested") }
      }
    }
    return settle.promise
  }

  // MARK: Called by the forwarder and the central (all on the queue)

  func handleDisconnect(reason: String) {
    let wasConnected = connected
    connected = false
    central.forget(self, peripheral)
    let error = bleError("E_DISCONNECTED", "The device disconnected: \(reason)")
    discovery?.reject(error)
    discovery = nil
    let jobs = writes
    writes.removeAll()
    staleResponses = 0
    for job in jobs { job.settle.reject(error) }
    let waiting = notifyWaiters
    notifyWaiters.removeAll()
    for (_, waiter) in waiting { waiter.reject(error) }
    let reading = readWaiters
    readWaiters.removeAll()
    for (_, waiter) in reading { waiter.reject(error) }
    subscribers.removeAll()
    let closers = disconnectWaiters
    disconnectWaiters.removeAll()
    for closer in closers { closer.resolve(()) }
    if wasConnected && !disconnectNotified {
      disconnectNotified = true
      onDisconnect(requestedClose ? "requested" : reason)
    }
  }

  func didDiscoverServices(_ error: Error?) {
    guard let settle = discovery else { return }
    if let error = error {
      discovery = nil
      settle.reject(BleSupport.mapError(error, fallbackCode: "E_DISCOVERY", action: "Service discovery"))
      return
    }
    let services = peripheral.services ?? []
    servicesToDiscover = services.count
    if services.isEmpty { finishDiscovery() }
    for service in services { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func didDiscoverCharacteristics(for service: CBService, error: Error?) {
    guard let settle = discovery else { return }
    if let error = error {
      discovery = nil
      settle.reject(BleSupport.mapError(error, fallbackCode: "E_DISCOVERY", action: "Characteristic discovery"))
      return
    }
    servicesToDiscover -= 1
    if servicesToDiscover <= 0 { finishDiscovery() }
  }

  private func finishDiscovery() {
    guard let settle = discovery else { return }
    discovery = nil
    var out: [BleCharacteristic] = []
    for service in peripheral.services ?? [] {
      for c in service.characteristics ?? [] {
        out.append(BleCharacteristic(
          serviceUuid: BleSupport.fullUuid(service.uuid),
          uuid: BleSupport.fullUuid(c.uuid),
          read: c.properties.contains(.read),
          write: c.properties.contains(.write),
          writeWithoutResponse: c.properties.contains(.writeWithoutResponse),
          notify: c.properties.contains(.notify),
          indicate: c.properties.contains(.indicate)))
      }
    }
    settle.resolve(out)
  }

  func didWrite(_ characteristic: CBCharacteristic, error: Error?) {
    // The answer of a write that already timed out. CoreBluetooth answers in order, so it comes first.
    if staleResponses > 0 {
      staleResponses -= 1
      return
    }
    guard let job = writes.first, job.started, job.withResponse, job.characteristic === characteristic else { return }
    writes.removeFirst()
    if let error = error {
      job.settle.reject(BleSupport.mapError(error, fallbackCode: "E_WRITE", action: "Write"))
    } else {
      job.settle.resolve(())
    }
    pump()
  }

  /// Start the first queued write. Without response, wait until CoreBluetooth has room (`canSendWriteWithoutResponse`).
  func pump() {
    guard connected, let job = writes.first else { return }
    if !job.began {
      job.began = true
      armTimer(job)
    }
    guard !job.started else { return }
    if job.withResponse {
      job.started = true
      peripheral.writeValue(job.data, for: job.characteristic, type: .withResponse)
    } else if peripheral.canSendWriteWithoutResponse {
      writes.removeFirst()
      peripheral.writeValue(job.data, for: job.characteristic, type: .withoutResponse)
      job.settle.resolve(())
      pump()
    }
    // Otherwise `peripheralIsReady(toSendWriteWithoutResponse:)` calls pump() again. Apple's forum says the callback can be
    // missing while the app is in the background, so the job's own time limit (armTimer) ends a wait that never ends.
  }

  /// The time limit of a job runs from the moment it reaches the head of the queue. It covers both a missing response
  /// and a missing `peripheralIsReady`. A job behind a slow one does not lose its time waiting.
  private func armTimer(_ job: WriteJob) {
    queue.asyncAfter(deadline: .now() + job.limitMs / 1000.0) { [weak self] in
      guard let self = self, let index = self.writes.firstIndex(where: { $0 === job }) else { return }
      self.writes.remove(at: index)
      if job.started && job.withResponse { self.staleResponses += 1 }
      job.settle.reject(bleError("E_TIMEOUT", "write timed out after \(Int(job.limitMs)) ms"))
      self.pump()
    }
  }

  func didUpdateNotificationState(_ characteristic: CBCharacteristic, error: Error?) {
    guard let waiter = notifyWaiters.removeValue(forKey: characteristic) else { return }
    if let error = error {
      subscribers.removeValue(forKey: key(characteristic))
      waiter.reject(BleSupport.mapError(error, fallbackCode: "E_NOTIFY", action: "Notification setup"))
    } else {
      waiter.resolve(())
    }
  }

  func didUpdateValue(_ characteristic: CBCharacteristic, error: Error?) {
    // A pending read() takes this update. Otherwise it is a notification.
    if let waiter = readWaiters.removeValue(forKey: characteristic) {
      if let error = error {
        waiter.reject(BleSupport.mapError(error, fallbackCode: "E_READ", action: "Read"))
      } else if let buffer = try? ArrayBuffer.copy(data: characteristic.value ?? Data()) {
        waiter.resolve(buffer)
      } else {
        waiter.reject(bleError("E_READ", "The value could not be copied"))
      }
      return
    }
    guard error == nil, let value = characteristic.value, let handler = subscribers[key(characteristic)] else { return }
    if let buffer = try? ArrayBuffer.copy(data: value) { handler(buffer) }
  }

  // MARK: Helpers

  private func key(_ c: CBCharacteristic) -> String {
    let service = c.service.map { BleSupport.fullUuid($0.uuid) } ?? ""
    return service + "/" + BleSupport.fullUuid(c.uuid)
  }

  private func find(_ serviceUuid: String, _ characteristicUuid: String) throws -> CBCharacteristic {
    let wantedService = BleSupport.fullUuid(try BleSupport.parseUuid(serviceUuid))
    let wantedCharacteristic = BleSupport.fullUuid(try BleSupport.parseUuid(characteristicUuid))
    guard let service = (peripheral.services ?? []).first(where: { BleSupport.fullUuid($0.uuid) == wantedService }) else {
      throw bleError("E_NO_CHARACTERISTIC", "Service \(serviceUuid) not found on the device. Call discover() first.")
    }
    guard let c = (service.characteristics ?? []).first(where: { BleSupport.fullUuid($0.uuid) == wantedCharacteristic }) else {
      throw bleError("E_NO_CHARACTERISTIC", "Characteristic \(characteristicUuid) not found in service \(serviceUuid)")
    }
    return c
  }
}
