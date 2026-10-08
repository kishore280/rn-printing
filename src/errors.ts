export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPlatformError';
  }
}

export class TransportError extends Error {
  code?: string | undefined;
  /** A failed write: bytes the link accepted before it failed. Not set for other errors. */
  bytesSent?: number | undefined;
  /** A failed write: true when no native write had started, so nothing can be printing. Only then is a second send safe. */
  nothingSent?: boolean | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export class PrinterNotReadyError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Printer not ready: ${reasons.join(', ')}`);
    this.name = 'PrinterNotReadyError';
    this.reasons = reasons;
  }
}

/** The native module is not linked. Rebuild the app after installing the package. */
export class NativeModuleMissingError extends Error {
  constructor(name: string) {
    super(
      `The native object "${name}" is not available. Install react-native-nitro-modules, rebuild the app ` +
        '(pod install on iOS, a Gradle sync on Android), and do not run in Expo Go.'
    );
    this.name = 'NativeModuleMissingError';
  }
}
