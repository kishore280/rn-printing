/**
 * Every error code that this package throws, in one table. The Kotlin, Swift and TypeScript code use these codes, and a test
 * (`__tests__/errorCodes.test.ts`) reads all three and fails when one uses a code that is not here.
 *
 * - `transient`: a new attempt can help (a radio failure, a timeout). `LabelPrinter` retries only these.
 * - `beforeAnyByte`: the error comes before any byte of a job could go out. A print log may say "not sent". Any other code may have
 *   printed part of a label: paper cannot be taken back.
 * - `userFix`: only the person can fix it (allow Bluetooth, switch it on, choose the printer again). Never retried.
 */
export interface ErrorCodeInfo {
  readonly meaning: string;
  readonly transient: boolean;
  readonly beforeAnyByte: boolean;
  readonly userFix: boolean;
}

const info = (meaning: string, flags: Partial<Omit<ErrorCodeInfo, 'meaning'>> = {}): ErrorCodeInfo => ({
  meaning,
  transient: false,
  beforeAnyByte: false,
  userFix: false,
  ...flags,
});

export const ERROR_CODES = {
  E_PERMISSION: info('The Bluetooth permission is not granted.', { beforeAnyByte: true, userFix: true }),
  E_BLUETOOTH_OFF: info('Bluetooth is off.', { beforeAnyByte: true, userFix: true }),
  E_NO_ADAPTER: info('The phone has no Bluetooth (Low Energy) adapter.', { beforeAnyByte: true, userFix: true }),
  E_LOCATION_OFF: info('Android 11 and older: the location switch is off, so a scan finds nothing.', { beforeAnyByte: true, userFix: true }),
  E_AUTH: info('The device needs pairing, or the pairing was removed.', { beforeAnyByte: true, userFix: true }),
  E_BAD_ADDRESS: info('The saved address is not a Bluetooth address.', { beforeAnyByte: true, userFix: true }),
  E_BAD_UUID: info('A UUID was not valid. A programming error.', { beforeAnyByte: true }),
  E_DEVICE_NOT_FOUND: info('The phone does not know this device (iOS: not in the list of known peripherals).', { beforeAnyByte: true, userFix: true }),
  E_NO_CHARACTERISTIC: info('No characteristic fits (nothing to write to).', { beforeAnyByte: true, userFix: true }),
  E_NOT_READABLE: info('The characteristic cannot be read. A programming error.', { beforeAnyByte: true }),
  E_SCAN_FAILED: info('The platform refused the scan.', { beforeAnyByte: true }),
  E_SCAN_THROTTLED: info('Android: more than 5 scan starts in 30 s. Wait 30 s.', { beforeAnyByte: true }),
  E_CONNECT: info('The link could not be opened.', { transient: true, beforeAnyByte: true }),
  E_DISCOVERY: info('The service table could not be read.', { transient: true, beforeAnyByte: true }),
  E_NOT_CONNECTED: info('There is no open link (no byte was sent).', { transient: true, beforeAnyByte: true }),
  E_TIMEOUT: info('An operation did not finish in time.', { transient: true }),
  E_WRITE: info('A write failed.', { transient: true }),
  E_READ: info('A read failed.', { transient: true }),
  E_DISCONNECTED: info('The link closed during the operation.', { transient: true }),
  E_NOTIFY: info('The notification subscription failed. Printing still works; replies are lost.'),
  E_CANCELLED: info('The job was cancelled by the caller.'),
  E_BLUETOOTH: info('A Bluetooth Classic call failed, with no more exact code.'),
} as const satisfies Record<string, ErrorCodeInfo>;

export type TransportErrorCode = keyof typeof ERROR_CODES;

export function isKnownErrorCode(code: string): code is TransportErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

export function errorCodeInfo(code: string | undefined): ErrorCodeInfo | null {
  return code !== undefined && isKnownErrorCode(code) ? ERROR_CODES[code] : null;
}
