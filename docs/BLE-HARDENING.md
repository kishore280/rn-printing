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
