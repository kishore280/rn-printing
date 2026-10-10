# BLE hardening: what mature projects do, and where this package stands

Date: 2026-10-08. Method: four research passes (Android, iOS, printer SDKs and BLE libraries, and a read-only audit of our code),
then a check of the top findings in the code, then fixes with tests. Nothing here was run on the TVS LP 46 Dlite.
`[V]` = the source page was read. `[S]` = a search snippet only. `[U]` = not verified (from memory, or the page did not load).

## 1. Rules that mature projects follow

### Android (Nordic Android-BLE-Library, Android docs, Punch Through)

| Rule | Source |
| --- | --- |
| One GATT operation at a time. Android has no queue. Wait for the callback of each operation. | [V] https://punchthrough.com/android-ble-guide/ , https://github.com/NordicSemiconductor/Android-BLE-Library |
| Always `close()` the `BluetoothGatt` after a disconnect or a failed connect. | [V] Punch Through |
| After `close()`, wait 200 ms before a new `connectGatt` to the same device (Nordic: `Thread.sleep(200)`, "Is 200 ms enough?"). | [V] BleManagerHandler.java ~680 |
| `autoConnect = false` for a connect the user wants now. | [V] Nordic USAGE.md, Android `connect-gatt-server` page |
| Retry only a failure that comes inside 20 s (`CONNECTION_TIMEOUT_THRESHOLD`). A failure after 20 s is a timeout and is not retried. Nordic uses `retry(3, 100)`. | [V] BleManagerHandler.java:96-102, USAGE.md |
| Delay `discoverServices()`: 1600 ms when bonded, 300 ms when not. Skip it while `BOND_BONDING`. Drop a stale delayed call with a connection counter. | [V] BleManager.java ~663, BleManagerHandler ~2220 |
| Call `requestMtu` once after connect. Payload = MTU - 3. Until `onMtuChanged`, assume 20. Android 14+ negotiates MTU by itself and fires `onMtuChanged` unasked. | [V] Punch Through |
| Do not trust the connection-priority callback: Nordic completes it 200 ms after the call returns. | [V] BleManagerHandler:3819-3835 |
| Status 133 (0x85) and 147 (0x93, new in Android 15): transient. Close, wait, retry. 8 = supervision timeout (transient). 19 = peer ended the link (printer slept: reconnect on the next job). 22 = we ended it (no retry). 62 = could not establish (transient). 5 / 15 = needs bonding. 13 = write longer than MTU - 3. 3 = not writable. | [V] Nordic GattError.java. Spec text of the HCI codes [U]. |
| Do not scan more than 5 times in 30 s. Excess scans fail silently. | [V] Punch Through, flutter_blue_plus README |
| Write without response: the promise resolves when queued, not when delivered. Pace it, or use write with response for big or critical data. flutter_blue_plus allows long or split writes only with response. | [S] ble-plx wiki, [V] flutter_blue_plus README |
| Reflection `BluetoothGatt.refresh()` is opt-in only (Nordic `shouldClearCacheWhenDisconnected`). Android 9+ restricts it. | [V] Punch Through, Nordic |
| Permissions Android 12+: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`. Android 11 and older: location, and the location switch must be on to scan. `neverForLocation` filters some beacons. | [V] developer.android.com bt-permissions |
| Some phones fail to connect while scanning (Huawei P8 Lite). Stop the scan before you connect. | [V] flutter_blue_plus README ~930 |
| Samsung: some Android 11 / 12 builds return 133 for writes longer than 20 bytes with a large MTU. | [S] Samsung developer forum threads |

### iOS (CoreBluetooth)

| Rule | Source |
| --- | --- |
| Wait for `poweredOn` before scan, connect or `retrievePeripherals`. States: poweredOff, poweredOn, resetting, unauthorized, unknown, unsupported. | [V] developer.apple.com cbmanagerstate |
| `connect` has no timeout ("Attempts to connect to a peripheral don't time out."). Run your own timer, then `cancelPeripheralConnection`. | [V] cbcentralmanager/connect |
| Hold a strong reference to every peripheral. Dropping it cancels the connect. | [V] same page |
| After a disconnect, all services and characteristics are invalid. Discover them again on every connect. | [V] didDisconnectPeripheral page |
| Reconnect with `retrievePeripherals(withIdentifiers:)` and the saved UUID. Fall back to a scan when it returns an empty array. | [V] retrieveperipherals page |
| Write without response: send only while `canSendWriteWithoutResponse` is true. Resume in `peripheralIsReady(toSendWriteWithoutResponse:)`. The callback can stall in the background: add a stall timeout. | [V] Apple page, [S] Apple forums 812376, 804997 |
| Piece size from `maximumWriteValueLength(for:)` for the write type in use. | [V] Apple page |
| `unauthorized`, `poweredOff`, `restricted`, "peer removed pairing information" are user-fix errors. Never auto-retry them. | [V] CBError.Code, [S] Apple forum 132488 |
| State restoration needs a restore identifier, `bluetooth-central` in `UIBackgroundModes`, and a manager made at launch. A print flow in the foreground does not need it. | [V] Apple archive guide |

### Printer SDKs (Zebra, Epson, Star) and BLE libraries

- No mature library gives one rich link state. Epson is closest: connection events `RECONNECTING`, `RECONNECT`, `DISCONNECT` [V]. ble-plx gives a disconnect callback. flutter_blue_plus gives a two-value stream.
- Adapter state (on, off, unauthorized) is always a separate stream: ble-plx `onStateChange`, flutter_blue_plus `adapterState`.
- Printer status is always separate from link state. Zebra `getCurrentStatus()` is a snapshot and throws when the link is closed. Epson sends status events after `startMonitor`.
- Nobody documents a back-off. Our rule (cockatiel, decorrelated jitter, started when a job begins) is stricter than the field.
- Epson says its disconnect event can lag about 30 s. So never trust the link state alone: look at the age of the last status.
- IPP (RFC 8011) gives the vocabulary for printer state: `idle`, `processing`, `stopped`, and reason keywords (`media-empty`, `cover-open`, `marker-supply-empty`, ...) with the suffix `-report`, `-warning` or `-error`.

## 2. Audit of this package (read from the code, then the top items checked)

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | BUG, Android 14+ | `GattOpGuard.complete(status)` had no operation kind. Android 14 starts its own MTU exchange, and the unasked `onMtuChanged` could complete a waiting discovery or write. | **Fixed** (kinds; 2 test groups; compiled; guard test 42 checks) |
| 2 | BUG, leak | A fast failure callback could run before `gatt` was set, so `closeGatt()` skipped `close()`. | **Fixed** (`closeGatt(g)` uses the callback's object) |
| 6 | RISK | `BluetoothLETransport.connect()` could be overtaken by `disconnect()` or a newer `connect()`. The older one wiped the newer link, and "connected" was set after a link loss. | **Fixed** (generation check after each await, `isConnected` check at the end; 3 tests, shown to fail without the fix) |
| 12 | RISK | A late notification of an old link landed in the inbox of the next link. | **Fixed** (generation check; test) |
| 14 | RISK | Android pairing statuses (5, 15, 137) during connect became `E_CONNECT` and were retried. | **Fixed** (`E_AUTH`, not retried) |
| - | GAP | `LabelPrinter` had no connection state, no events and no cancel. A screen kept its own reference to the transport. | **Added** (`connectionState`, `onConnectionState`, `cancel`; optional on `Transport`; tests) |
| 4 | RISK, iOS | Connection entries have no generation token. A late `didDisconnect` of an old link can remove the new attempt. | Open. Swift is not compiled here. |
| 5 | RISK, iOS | `maximumWriteValueLength(for: .withResponse)` is often 512, which makes CoreBluetooth use long writes. Cheap printer firmware often lacks them. | Open. Fix: use the smaller of the two lengths. Swift not compiled. |
| 10 | RISK, iOS | `requestPermissions()` returns before the user answers (the state is `unknown` at that moment). | Open. Needs a "first state update" promise. |
| 3 | RISK | No GATT cache refresh when the characteristic table is wrong (`E_NO_CHARACTERISTIC`). | **Not done on purpose.** It needs the hidden `BluetoothGatt.refresh()` (reflection). Punch Through says Android 9+ restricts it, and Nordic keeps it opt-in. Toggle Bluetooth instead. Revisit only if seen in the field. |
| 7 | RISK | A cancel while a job waits in the queue was lost. | **Fixed** (`print(label, { signal })`; aborted jobs never connect; test) |
| 8 | RISK | `TransportError` did not say how many bytes went out. | **Fixed** (`bytesSent`, `nothingSent`). A write that failed before any native write began is sent again once. A write that may be in the printer is never sent again. 4 tests. |
| 9 | RISK | A scan with no time limit did not end when Bluetooth went off. | **Fixed** (the scan watches the adapter, ends with `E_BLUETOOTH_OFF`). The one state receiver per process is kept: it is replaced, not added. |
| 16 | RISK | HIGH connection priority is never lowered. No discovery delay (Nordic: 300 / 1600 ms). | Open. Delay only if seen in the field. |
| 17 | RISK | The scan throttle (error 6) had no code. On Android 11 and older nobody checked the location switch. | **Fixed** (`E_SCAN_THROTTLED`, `E_LOCATION_OFF`). Compiled only. |
| 18 | RISK | Two GATT clients to one address are not prevented (`BluetoothLE.inspect()` plus the transport). Many printers allow one central. | Open. |
| 19 | RISK | iOS write timer starts when the job is queued, and a timed-out job can resolve the next one. Not reachable through the TS transport. | Open. |

## 3. What the app must still do (not the package)

- Never prompt from a timer or a page open. Done in the app (version 1.18.29): reading Bluetooth state never asks.
- One failed check must not turn the screen to "Not connected". Done in the app: `link-state.ts` and `smoothSnapshot`.
- The app should now read `LabelPrinter.connectionState` and `onConnectionState` instead of casting to the transport. Needs a new package commit pin in the app.

## 4. Design for a session layer (next step, from the SDK research)

Three streams, kept apart: adapter, link, printer status. The link has a `reconnecting` phase with attempt and next-try time
(Epson's model). The printer status uses the IPP words, and "link up but no `~HS` reply" is its own value (`silent`), never "ready".
`LabelPrinter` would own the three. Reconnect still starts only when a job starts. The sketch is in the research notes
of the session. It is not built yet; items 3 to 9 in the table above come first.

## 5. Hardware test plan (open items, unchanged by this work)

These numbers are guesses until the TVS is tested: write mode (`auto`, write without response first), the 10 ms pacing, the MTU
the printer accepts, the chunk size, the connect timeout (10 s), the back-off (300 ms, x2, cap 2 s), and the idle disconnect.
Run `example/BleHardwareTest.tsx` on Android 12+, Android 14+, and an iPhone. Check these cases: printer off mid-job, out of range,
Bluetooth toggled mid-job, app to background mid-job, two phones, phone asleep, a job of 5000 pieces.

## 6. Not verified

The issue lists of flutter_blue_plus and react-native-ble-plx (no verified URLs), the HCI spec text, Android 15 changes other than
status 147, StarXpand and Brother SDK pages, Zebra `ConnectionTimeout`, and every number for the SNBC printer.

## 7. Round 2: operating systems, papers, failure detectors (2026-10-08)

Five more research passes. [V] = read, [S] = snippet, [U] = not verified. Full links are in the lists below.

### What the operating systems do

All three desktop and phone stacks keep the layers apart: adapter power, link, security, "services resolved", and the result of each operation.
- Linux BlueZ [V]: `Adapter1.Powered`, `Device1.Connected`, `Device1.ServicesResolved`, `Paired`, `Trusted`; `WriteValue` option `type` = `command` (without response), `request` or `reliable`. `Connected=true` with `ServicesResolved=false` is a real state (a race is reported [S]). Our `BluetoothLETransport` reports `connected` only after discovery, so that state is never shown as ready.
  https://raw.githubusercontent.com/bluez/bluez/master/doc/org.bluez.Device.rst , .../org.bluez.GattCharacteristic.rst , .../org.bluez.Adapter.rst
- Windows [V]: `GattSession.SessionStatus` (Active, Closed), `MaintainConnection` (the system waits for the device, nothing for the app to wait on), `MaxPduSize` read-only with a change event, and a per-call `GattCommunicationStatus` (Success, Unreachable, ProtocolError, AccessDenied).
  https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.genericattributeprofile.gattsession
- Apple [V]: `centralManager(_:didDisconnectPeripheral:timestamp:isReconnecting:error:)` (iOS 17+) and `CBConnectPeripheralOptionEnableAutoReconnect`. `isReconnecting` meaning is inferred [U].
  https://developer.apple.com/documentation/corebluetooth/cbconnectperipheraloptionenableautoreconnect.md
- Android [S]: one `onConnectionStateChange` callback. The layers must be rebuilt by the app. That is what `BluetoothLETransport` and `LabelPrinter` do.
- Real flow control: ATT write without response has none. Apple gives a host-queue signal (`canSendWriteWithoutResponse`). Android's write callback only says the stack took the bytes. L2CAP credit-based channels are the standard answer for bulk data, but need a printer that offers a PSM [U].

### What the papers say (only what was read)

I found NO peer-reviewed study of BLE central bugs on Android or iOS. Do not cite one.
- Makhshari and Mesbah, "IoT Bugs and Development Challenges", ICSE 2021 [V, partly]: connectivity is the most frequent and most severe bug class (97.2 % of 194 developers met it). Its taxonomy has "reconnection", "disconnection" and "timing/rate/ordering". https://people.ece.ubc.ca/amesbah/resources/papers/iot-icse21.pdf
- Wu et al., BLESA, USENIX WOOT 2020 [V]: on reconnect, Android and iOS clients kept going without encryption after it failed. Rule: abort on a failed security step. https://www.cs.purdue.edu/homes/dxu/pubs/WOOT20.pdf
- Garbelini et al., SweynTooth, USENIX ATC 2020 [V, partly]: 11 new flaws in peripheral stacks (deadlock, crash, truncated packets). Rule: every wait has a timeout, and a stuck peer must not stick the library. https://www.usenix.org/conference/atc20/presentation/garbelini
- Pferscher and Aichernig, automata learning of 6 BLE devices (2023) [V, partly]: the same request gets different answers from different stacks. https://arxiv.org/abs/2211.16074
- Bulic et al., Sensors 19(17):3746, 2019 [V]: for write without response the connection interval is not the main lever. https://pmc.ncbi.nlm.nih.gov/articles/PMC6749335/
- Pang et al., arXiv:2405.01231 (2024) [V]: link-layer retransmission is automatic; under high bit error rate, smaller packets are more reliable. https://arxiv.org/abs/2405.01231
- Punch Through, throughput articles [V]: Android queue depth can be 1 with no feedback when overwritten; about 50 KB/s with DLE on newer phones. https://punchthrough.com/ble-transfer-methods-for-throughput/ , https://punchthrough.com/ble-throughput-part-4/
- Apple Developer Forums 770717 [V, forum]: iPhone 16 Pro, write without response, about 300 to 600 kbps against well over 1000 kbps on Android. Pace by the ready flag, not a timer.
- Hayashibara et al., phi accrual detector (2004) [S]; Chen, Toueg, Aguilera, QoS of failure detectors (2002) [S]; SWIM (2002) [S]; Huang et al., gray failure, HotOS 2017 [S]. Used for `linkHealth.ts`: suspicion before loss, requirements as numbers, "connected is not healthy".
- Linux `net/core/link_watch.c` [V]: "Minimise down-time: drop delay for up event", and one event per second at most. NetworkManager `carrier-wait-timeout` 5 s [S]; systemd-networkd `IgnoreCarrierLoss` 3 to 5 s [V]. RFC 2439 (route flap damping) [V]: a decaying score with a cutoff above a reuse limit. Not built here: the app has one printer, so one grace time is enough.
- AWS "Exponential Backoff And Jitter" [V]; Google SRE "Handling Overload" and "Addressing Cascading Failures" [V]: always jitter, no retries stacked in layers, a retry budget. We have one layer (cockatiel).

### Defaults and their evidence

| Parameter | Value now | Evidence | Confidence |
| --- | --- | --- | --- |
| MTU request | 247 | Punch Through (Android max 517, DLE 251) | medium |
| Piece size | min(MTU - 3, platform limit) | Punch Through | high for the overhead math |
| Write without response pacing, Android | callback plus 10 ms | one Nordic forum report fixed loss with 50 ms | low: test 10 to 50 ms on the TVS |
| Write without response pacing, iOS | `canSendWriteWithoutResponse` | Apple docs, forum 770717 | high |
| Link grace before "lost" | 4 s | NetworkManager 5 s, systemd-networkd 3 to 5 s | medium |
| Hard failures for "lost" | 2 | our choice | low |
| Connect timeout | 10 s | Android shows 4 to 5 s outliers [S] | low |
| Retry | 3 tries, 300 ms x2, cap 2 s, jitter | AWS, SRE, Nordic `retry(3, 100)` | low: not measured on the printer |

### Tests added from this research

- Callback order: a table of every (operation kind x callback kind) case in `test-native/GattOpGuardTest.kt` (117 checks), including Android 14's unasked MTU callback.
- Soak: 150 connect / print / disconnect cycles with random failures (`__tests__/bluetoothLE.test.ts`): every link closed, no leaked listener, clean recovery.
- Property test: the chunker, 2000 random cases (`__tests__/properties.test.ts`).
- Fuzz: the status parsers, every truncation and 3000 random strings.
- Link health: a first connect that fails is not a loss; a link that returns inside 4 s never shows `lost`; two hard failures in a row do.
- Error codes: Kotlin, Swift and TS are read by a test and must use only codes of the table.

### Not done, and why

- Bumble or Root Canal on an emulator, CoreBluetoothMock, and AALpy model learning: useful, but each needs tooling that is not in this container. Listed as the next test layer.
- L2CAP credit-based channels: the TVS is not known to offer a PSM.
- Reconnect by the OS (`MaintainConnection`, iOS auto-reconnect, Android `autoConnect`): we reconnect when a job starts, as before. Add it only if the hardware test shows a need.

## 8. Round 3: pairing (bonding) and the iOS code (2026-10-08)

### Pairing (bonding)

What the mature projects do:

- Nordic Android-BLE-Library: `createBond()` is a separate step with its own wait for `ACTION_BOND_STATE_CHANGED`. It waits while the state is `BOND_BONDING` before service discovery, because a discovery during pairing fails. On Android 7 and older it adds a 300 ms delay before discovery (1600 ms when the device is bonded).
- The Android docs: a bond starts by itself when a read, write or subscribe needs encryption and the stack gets an authentication error. An app may also call `createBond()`.
- Apple: there is NO pairing API. iOS pairs by itself at the first operation that needs encryption, and shows its own dialog. A failure comes back as `CBATTError.insufficientAuthentication` or `.insufficientEncryption`, or as `CBError.peerRemovedPairingInformation` when the printer forgot the bond.

What we do (`bond: 'auto'` is the default; `bond: 'never'` turns it off):

1. A GATT operation fails with status 5, 15 or 137 (or a pairing error on the CCCD write). Kotlin maps it to `E_AUTH`.
2. `BluetoothLETransport.withBond()` sees `E_AUTH`. Once per connection, it calls `link.bond(bondTimeoutMs)` (default 30 s).
3. On Android, `bond()` calls `createBond()` and waits for the broadcast. If the device is bonded, the TS layer repeats the operation once. If not, it throws `E_AUTH` ("The device was not paired…"). The user must fix this, so it is not retried.
4. On iOS, `bondState` is `unknown` and `bond()` resolves `true` at once. The repeat of the operation is what makes iOS ask the user to pair.
5. A job that failed with `E_AUTH` before any byte went out is `nothingSent`, so the retry layer may start it again safely.

Not verified: the TVS LP 46 Dlite may not need pairing at all. A user wrote to it with nRF Connect and it printed. The flow is unit-tested with a fake link (8 tests) and the Kotlin code is compiled. It has not run on a device.

### iOS code written from Apple's documentation (NOT compiled, NOT run)

No Swift toolchain exists here. Each item follows the Apple documentation named, and each is open for a Mac build.

| Item | Change | Source |
| --- | --- | --- |
| Piece size with response | `maxWriteLength(withResponse: true)` returns the smaller of the with-response and without-response values, so one piece size is safe in both modes. | `CBPeripheral.maximumWriteValueLength(for:)` |
| Write timer | The time limit of a write runs from the moment the job reaches the head of the queue. Before, it ran from the call, so a job behind a slow one could time out without being tried. | Own rule; Nordic queues requests the same way |
| Late answers | A write with response that timed out still gets its `didWrite` later. A counter (`staleResponses`) drops that answer, so it cannot finish the next job. CoreBluetooth answers in order. | `peripheral(_:didWriteValueFor:error:)` |
| Missing ready callback | A write without response waits for `peripheralIsReady(toSendWriteWithoutResponse:)`. Apple's forum says it can be missing in the background. The job's time limit now ends that wait with `E_TIMEOUT`. | `canSendWriteWithoutResponse`; Apple developer forum |
| Connect attempts | A second `open()` for the same device rejects the first and closes the old link. A timer of an old attempt no longer ends a newer one. A late `didDisconnectPeripheral` is ignored when the peripheral is connecting or connected again. `forget` only removes the link that is current. | `CBPeripheral.state`; Nordic `BleManager` |
| Permission wait | `requestPermissions()` on iOS starts the system dialog (the first `getState()` creates the manager) and waits for the first state that is not `unknown` or `resetting`. Before, it returned at once with `unknown`. Unit-tested in TypeScript (3 tests); the native side is not run. | `CBManager.authorization`, `centralManagerDidUpdateState` |
| Pairing | `bondState` is `"unknown"`, `bond()` resolves `true`. See above. | Apple has no pairing API |

Also fixed in TypeScript: the one state listener is now tied to the native object that holds it (it was a global flag, so a second native object was never hooked).

### Still open

- Run the hardware tests (Android, iOS) with the TVS LP 46 Dlite. Check if it asks for pairing.
- Compile the Swift files on a Mac. The new code is small, but it has never met a compiler.
- Bumble or CoreBluetoothMock test layers (see section 7).

## 9. Round 4: the source code itself (2026-10-08)

Read in this round (shallow clones, current `main` of each): AOSP `packages/modules/Bluetooth` (`framework/java`, `system/stack/gatt`, `system/stack/btm`, `system/btif`, `android/app/.../btservice`), the Linux kernel (`net/bluetooth`, `include/net/bluetooth`, `net/core/link_watch.c`), BlueZ (`src/shared`), and Nordic Android-BLE-Library (`BleManagerHandler.java`). CoreBluetooth is closed source: the iOS items stay from Apple's documentation only.

| Finding | Where | What it changes |
| --- | --- | --- |
| `BluetoothGatt` already retries a read, write, or descriptor write that fails with status 5 or 15: first with `AUTHENTICATION_NO_MITM`, then `AUTHENTICATION_MITM` (`mAuthRetryState`). The stack then calls `BTM_SetEncryption`, which starts pairing. | `framework/java/android/bluetooth/BluetoothGatt.java` (about lines 513, 585, 704, 768); `system/stack/gatt/gatt_auth.cc` `gatt_security_check_start` | On Android the system pairs by itself in the normal case. Our `bond()` runs only after those retries failed. The text of `docs/BLE.md` now says so. |
| With `auth_req` NONE (the default) the stack does NOT start encryption before an operation. | `gatt_auth.cc` `gatt_determine_sec_act` (`if (auth_req == GATT_AUTH_REQ_NONE) return act;`) | A write WITHOUT response to a protected characteristic gets no ATT error, so there is no `E_AUTH` to react to. The first write with response (or the CCCD write at connect) is what starts pairing. Open for the hardware test. |
| `GATT_AUTH_FAIL` (0x89 = 137) is what an operation gets when the security step itself fails (for example the user says no). It is NOT in the framework retry list. | `gatt_auth.cc` `gatt_sec_check_complete` | Our `E_AUTH` mapping of 137 is right. A second pairing dialog after a refusal is possible once per connection, then never. |
| `createBond()` over `TRANSPORT_AUTO` picks BR/EDR when a Classic link to the device is up. It picks LE only when no Classic link is up and an LE link is. | `system/stack/btm/btm_ble.cc` `BTM_UseLeLink`; `btm_sec.cc` `BTM_SecBond` | Do not keep a Classic connection to the printer while bonding over BLE, or the bond lands on the wrong radio. `createBond(int transport)` is a system API: an app cannot choose. Noted in `docs/BLE.md`. |
| `createBond()` returns `false` when the device is already `BONDED`, and `true` when it is `BONDING`. Discovery is cancelled before pairing starts. | `btservice/AdapterService.java` `createBond` | Our Kotlin already checks `BOND_BONDED` first and `BOND_BONDING` before calling. Confirmed. |
| Android can report `BONDED` while the link is unencrypted, when the printer forgot the bond. Nordic documents it and has no fix. | `BleManagerHandler.java` (comment above `createBond`) | New: if the phone already had a bond, the retry still fails with `E_AUTH`, the error now says to forget the device in the Bluetooth settings and connect again. iOS reports the same case as `peerRemovedPairingInformation`. Unit-tested. |
| Nordic waits while `BOND_BONDING` before service discovery, and uses `CONNECTION_TIMEOUT_THRESHOLD = 20000` ms and a 200 ms sleep in its close path. | `BleManagerHandler.java` lines about 102, 685, 2241 | Our numbers match (bond wait, 200 ms settle). |
| Linux `link_watch`: an UP event is queued with no delay; other events are rate limited to about one per second (`HZ`). The 4 s grace of our `LinkHealth` comes from NetworkManager and systemd-networkd, NOT from the kernel. | `net/core/link_watch.c` (`linkwatch_add_event`: "Minimise down-time: drop delay for up event") | Doc wording kept exact. The number stays our choice. |
| Linux Bluetooth timeouts: `HCI_LE_CONN_TIMEOUT` 20 s, `HCI_ACL_CONN_TIMEOUT` 20 s, `HCI_PAIRING_TIMEOUT` 60 s, `HCI_ACL_TX_TIMEOUT` 45 s, `SMP_TIMEOUT` 30 s. BlueZ `ATT_TIMEOUT_INTERVAL` 30 s. | `include/net/bluetooth/hci.h`, `net/bluetooth/smp.c`, `bluez/src/shared/att.c` | Our connect timeout (20 s class) and bond timeout (30 s = SMP timeout) are in line. A write timeout above 30 s would be above the ATT transaction timeout, so keep write limits at or below it. |

Not read: CoreBluetooth and the iOS Bluetooth daemon (closed source), the Windows stack (closed source), Bluedroid's SMP state machine in detail.

## 10. Round 5: a removed printer must stay closed (2026-10-09)

**Found on the owner's phone** (TVS-like receipt printer, nRF Connect open beside the app): "Print a test receipt" kept loading, the person pressed Remove printer, the app showed no printer, but nRF Connect still showed the printer as connected, and a new search did not find it.

**Cause.** `LabelPrinter.dispose()` closed the transport, but a connect that was still inside its retry loop (`connectWithRetry`: up to 3 tries, 300 ms to 2 s apart, each up to 10 s) went on: its next try opened the link again. A BLE peripheral that has a central connected stops advertising, so the scan could not see it. A printer that takes one connection at a time (many cheap ones do) was now held by a printer object nobody used.

**Fix** (0.3.1). `dispose()` sets a flag. Every try of the retry loop, and every new job, checks it first and throws `E_CANCELLED` (not transient, so the loop stops at once). A native connect that is already running when `dispose()` is called is closed by the transport's generation check as soon as it finishes (`bluetoothLE.ts`: "The connection was closed while it opened"). Tests: `printer.test.ts`, "LabelPrinter dispose".

**Not fixed here, and worth knowing.** A native connect in flight cannot be aborted from JavaScript: it ends at its own timeout (10 s by default). Until then the printer shows as connected to the phone.

## 11. Round 6: a pairing that fails must not be a retry loop (2026-10-09)

**Found on the owner's phone** (SPRT SP-POS894UED, ESC/POS): the BLE pairing dialog opened again and again, and entering the PIN did not help. Source: the owner's agent, rn-printing issue 13 (adb logcat). The order in the log:

1. `connectGatt` succeeds (status 0).
2. The bond state changes to BONDING within milliseconds. The app did not ask for it: the package calls `createBond` only after an `E_AUTH` (`bond()`), and the printer asks for security by itself when the link opens, so Android starts the pairing.
3. The pairing fails (`smp_proc_pairing_cmpl: Pairing process has failed ... SMP_CONFIRM_VALUE_ERR`).
4. The printer closes the link: `GATT_CONN_TERMINATE_PEER_USER`, GATT status 19.
5. Android removes the bond. The next connect starts again.

**Cause in this package.** Status 19 became `E_CONNECT` or `E_DISCONNECTED`. Both are in `TRANSIENT` (`reconnect.ts`), so `connectWithRetry` tried again, and every try opened a new pairing dialog. `needsPairing()` knows only statuses 5, 15 and 137, which are for operations that fail with an authentication error, not for a link the device closes after a failed pairing.

**Fix** (0.3.2, Kotlin). `PairingWatch` (plain Kotlin, JVM test `test-native/PairingWatchTest.kt`) remembers a bond change from BONDING to NONE of this device while the connection lives (`HybridBleConnection.watchPairing`, a receiver for `ACTION_BOND_STATE_CHANGED`, removed when the GATT object closes). A link that closes (or an operation that finds it closed) within 15 s of that failure is reported as `E_AUTH`, with words that say what to do. `E_AUTH` is not in `TRANSIENT`, so the loop stops. With `bond: 'auto'` the TypeScript side still tries `createBond` once for the connection and then reports `E_AUTH`; with `bond: 'never'` it reports `E_AUTH` at once. Never a loop.

**Root cause on the printer, and the fix there.** The printer had its own "Enable Bluetooth Password" setting on. With it off, BLE worked. The vendor Setting Tool (V3.58, page `POS8811/POS891/2/3/4/5/6`) sends `1B 09` (enter setup mode), `1B 27 00` (Bluetooth password: No; `01` = Yes) and `1B 15` (leave setup mode and save) in one session. The same bytes alone, without the wrapper, had no effect. The printer does not reply. These bytes are from the owner's agent (Frida hook on `WriteFile`); we did not run them ourselves. They belong to this one printer family: do not send them to another printer.

**Not done.** Swift: iOS has no bond API and pairs by itself; there the close is still reported as a disconnect. Not run on a device: the Kotlin change is compiled and its rule is tested on a JVM only. The exact reason for `SMP_CONFIRM_VALUE_ERR` is not proven (our guess: the phone offers pairing with no passkey and the printer expects one).

## 12. Round 7: the write path read against BlueZ and Android (2026-10-10)

**What was read** (by a reviewer who had not written the code): BlueZ `src/shared/att.c` (one request at a time, the 30 s transaction timeout that shuts the link, a write command has no timer) and `gatt-client.c` (long write, notifications, service changed); AOSP `BluetoothGatt.java` and the stack `gatt_cl.cc`, `att_protocol.cc`, `gatt_utils.cc`, `gatt_int.h` (`GATT_WAIT_FOR_RSP_TIMEOUT_MS` = 30 s), `bta_gattc_act.cc`, `btif_gatt_client.cc`, `l2c_api.cc`, `l2c_utils.cc`. The kernel's `l2cap_core.c` and `hci_conn.c` were NOT read. Linux (BlueZ) is the reference for the rules; the phones run their own stacks, so the Android part is argued from AOSP.

**Found and fixed** (0.4.1):

1. **A pairing inside a write was cut by the write guard** (TypeScript, reproduced). The guard was `writeTimeoutMs + 1 s` around the whole `withBond`, so `bondTimeoutMs` (30 s) could never act: a person who needed 2 s for the pairing dialog got `E_TIMEOUT` and the link closed under the pairing. The guard now covers each native write, and the pairing has its own limit.
2. **Android, the same case in Kotlin** (argued from `BluetoothGatt.onCharacteristicWrite`, NOT run): Android holds a write that the device refused for lack of encryption (status 5 or 15), starts the pairing and repeats the write itself; the app gets no callback until the pairing ends, and our 5 s limit ended the job and the pairing with it. `awaitStatus` goes on waiting while `bondState` is BONDING, up to 30 s more.
3. **Android, status 143 (GATT_CONGESTED) on a write without response** (argued from `att_protocol.cc` "ATT congested, message accepted" and `gatt_cl.cc`; NOT run): the stack kept the data and says its queue is full. We treated it as a failed write and closed the link in the middle of a label. It is now accepted, and the next piece waits 100 ms (our choice, not measured). A later status 129 still fails the write.
4. **The state went back to `connected` after the link was lost during the last piece** (reproduced). `LabelPrinter` then fed `alive` to the link health. Fixed: only a link that is still the current one gets `connected`.
5. **The inbox had no limit** (reproduced: 20,000 notifications = 4.9 million entries). It keeps the newest 64 KiB now.

Each fix has a test in `__tests__/bluetoothLE-review.test.ts` that fails without it (the Kotlin fixes are compiled only: `bash scripts/check-kotlin.sh`).

**Open, not fixed** (not verified, or no safe fix without a printer):
- The tail of a job after a write without response can be lost if the app disconnects at once: a write command is complete when it is handed to L2CAP, and Android frees the queued data on disconnect (`l2cu_release_ccb`). Today the CCCD write of `unsubscribe` queues behind the data and acts as a barrier, but only when a notify characteristic is subscribed. On iOS `setNotifyValue(false)` is not awaited. A real fix needs a known flush signal; there is none in the public API.
- No settle delay (Nordic uses 200 ms) after a normal close before the next `connectGatt`. A transient status 133 is absorbed by the retry layer.
- Android 12 and older, one characteristic for write and notify: `c.value` is one mutable field. Theoretical.
- The 10 ms pacing also applies on iOS, where `canSendWriteWithoutResponse` already paces: throughput only.

## 13. Round 8: Classic Bluetooth and the BLE connect path (2026-10-10)

An independent reviewer read the Classic (SPP) code and the BLE scan, connect and permission code. Not read: BlueZ `profiles/serial`, the kernel `rfcomm/sock.c` and Android's `BluetoothSocket.java` (the fetch gave 404). So the points about `BluetoothSocket.isConnected()` below are from memory and are NOT verified.

**Found and fixed** (0.4.2):

1. **Classic: `dispose()` during a connect left the RFCOMM socket open** (TypeScript, reproduced). The native connect has no cancel and can block for many seconds. `dispose()` found no connection to close, and when the connect finished nobody closed its socket: a printer that takes one connection stayed held. BLE had a generation check; Classic had none. Now `BluetoothClassicTransport` counts connects and disconnects, and a connect that finishes after a `disconnect()` closes its socket and fails with `E_CANCELLED`. Test: `bluetoothClassic.test.ts`, fails without the fix.
2. **Classic: a permission taken away during the connect was retried.** A `SecurityException` ended as `E_CONNECT`, which is transient. It is now `E_PERMISSION`, so the person sees what to do (Kotlin, compiled only).
3. **BLE connect: an older link that was still opening was not closed** when a second connect to the same printer came (an inspect while the print link opens). Both opened, and the older one held the printer's single connection with nobody tracking it. Every older link is closed now (Kotlin, compiled only; argued from source).
4. **BLE connect: an exception in the 200 ms delayed open** ran on the main thread, so it would crash the app and leave the promise open. It rejects the promise now. A pairing receiver also stayed registered when `connectGatt` returned null: it is unregistered (Kotlin, compiled only).

**Then the open items were read against the sources and fixed** (0.4.2). Sources read this time: Android `BluetoothSocket.java` (`isConnected()` is `mSocketState == CONNECTED`, set to CLOSED only by our own `close()` or by an end of file in `read()`; `write()` has no catch, so a failure gives no count of bytes; `close()` aborts a blocking `connect()` from another thread; `connect()` says `cancelDiscovery()` is needed) and Linux `net/bluetooth/rfcomm/sock.c` (`rfcomm_sock_shutdown` waits only with `SO_LINGER`; `rfcomm_sock_destruct` does `skb_queue_purge(&sk->sk_write_queue)`: a close drops the data that is not sent; a send on a shut-down socket is `-EPIPE`). Not read: `bt_sock_wait_ready`, `rfcomm_dlc_send`, `bt_sock_poll`.

5. **Classic: the state of the link follows an event.** `isConnected` was local state, so after the printer powered off the first print went to a dead socket. A reader thread (`HybridClassicConnection.pump`) now blocks in `read()`: its end (-1 or an IOException) says the printer closed the link. `isConnected` is false then, so `LabelPrinter` opens a new link before the job. A write that finds the link closed throws the words `The printer had closed the connection before this write (nothing was sent)`; the TypeScript side maps them to `E_DISCONNECTED` with `nothingSent`, which is the only case where a resend is safe. Any other failed write still does not say "nothing sent" (the source shows no count of bytes). Test: `bluetoothClassic.test.ts`. Kotlin compiled, not run on a device.
6. **Classic: a connect has a time limit and no thread is left blocked.** All tries of one connect share 20 s (our choice, not measured); a watchdog closes the socket to abort a blocking `connect()` (the documented way).
7. **Classic: one dialog asks for BLUETOOTH_CONNECT and BLUETOOTH_SCAN** (`cancelDiscovery()` needs the second on Android 12+; both are in the "Nearby devices" group, so it is one dialog; from the Android documentation, not run). Only CONNECT is required.
8. **BLE: a settle delay after every close** (Nordic: 200 ms). `HybridBluetoothLE` notes the time of each close of a printer's link, whoever asked, and a new connect waits for the rest of the 200 ms.
9. **BLE: the receivers go with the object.** `dispose()` stops the scan and removes the state receiver.
10. **BLE: the probe of the first write without response** shortened the busy-retry time to 1 s. The refusal is tried again for the full time now, and only the wait for the callback is 1 s (`callbackWaitMs`).
11. **BLE: no pause between pieces on iOS.** CoreBluetooth gives the flow control (`canSendWriteWithoutResponse`, `peripheralIsReady`), and the Swift side waits for it. The 10 ms stays elsewhere. Test: `bluetoothLE-review.test.ts`.
12. **BLE: a disconnect right after a write without response reads the Device Name (0x2A00) first.** A request that the printer answers is ordered after the commands before it on the channel, so its answer says that the queued data was sent. The window is 2 s after the last such write; a failed read does not fail the disconnect. Test: `bluetoothLE-review.test.ts`. This is the Linux idea (drain before the close), made with the protocol's own ordering. NOT run on a printer: a printer whose Device Name needs pairing would answer with an authentication error (the answer is ignored).

**Still open:**
- Android 12 and older, one characteristic for write and notify. Read in `BluetoothGatt.java` (Android 12): `onNotify` does `characteristic.setValue(value)` and then `onCharacteristicChanged` one after the other in one Runnable on the callback thread, and `writeCharacteristic` reads `characteristic.getValue()` inside the call. So the notification's payload can be replaced only by a write from another thread in the few microseconds between the two lines, and no lock of ours can order a `setValue` that the stack does. The fix is the API of Android 13 (the value is an argument). Not fixed here, and the window is as small as it can be.

**Closed after that** (0.4.3): `requestEnable`'s activity listener is removed after 120 s if the activity was destroyed with the dialog open (Kotlin, compiled only).
