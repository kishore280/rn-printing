export { LabelPrinter } from './printer';
export type { StatusOptions, Printable, PrintAllOptions, WaitForPrinterOptions } from './printer';

export { ZplLabel, testLabel, mmToDots, escapeFieldData, zplSettings, zplDownloadImage } from './zpl';
export type {
  LabelOptions,
  TextOptions,
  Barcode128Options,
  QrOptions,
  Rotation,
  DotsPerMm,
  Barcode1DType,
  Barcode1DOptions,
  Pdf417Options,
  PrintMode,
  MediaType,
  PrintMethod,
} from './zpl';

export { CpclLabel, cpclSettings } from './cpcl';
export type { CpclLabelOptions, CpclTextOptions, CpclBarcodeOptions, CpclRotation } from './cpcl';

export { BplaLabel } from './bpla';
export type { BplaTextOptions, BplaBarcodeOptions, BplaRotation } from './bpla';


export { parseHostStatus, parseExtendedStatus } from './status';
export type { PrinterStatus, ExtendedStatus } from './status';

export type { Transport, ReadOptions } from './transport';
export { BluetoothClassic, BluetoothClassicTransport } from './transports/bluetoothClassic';
export type { PairedDevice, BluetoothClassicOptions } from './transports/bluetoothClassic';
export { BluetoothLE, BluetoothLETransport, bleFilters } from './transports/bluetoothLE';
export type {
  BleAdapterState,
  BleDevice,
  AbortSignalLike,
  BluetoothLEScanOptions,
  BleConnectOptions,
  BleConnectionState,
  BleConnectionStateEvent,
  BlePrinterProfile,
  BluetoothLETransportOptions,
  BleWriteOptions,
  BleWriteStats,
  BleDiagnostics,
  BleDeviceConnection,
} from './transports/bluetoothLE';
export { describeGatt } from './transports/bleGatt';
export type { BleGattCharacteristic, BleSelection, BleSelectionOptions, BleSelector, BleWriteMode } from './transports/bleGatt';
export { TcpTransport } from './transports/tcp';
export type { TcpTransportOptions, TcpSocketLike } from './transports/tcp';

export { UnsupportedPlatformError, TransportError, PrinterNotReadyError, NativeModuleMissingError } from './errors';
export { utf8Encode, base64Encode, base64Decode } from './encoding';
export { ditherRgba, ditherGray, compressBitmap } from './image';
export type { Bitmap1bpp, DitherMethod, DitherOptions } from './bitmap';
export { getNativeCodec, requireCodec, setNativeCodec } from './native';
export type { ReconnectOptions, ConnectionEvent } from './reconnect';
export type { LabelPrinterOptions } from './printer';
