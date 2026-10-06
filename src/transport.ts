export interface ReadOptions {
  /** Stop after this many ms in total. Default 1500. */
  timeoutMs?: number;
  /** After the first data arrives, stop when no data arrives for this many ms. Default 150. */
  idleMs?: number;
  /** Stop after this many bytes. 0 means no limit. Default 0. */
  maxBytes?: number;
}

/** A byte pipe to the printer. */
export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  write(data: Uint8Array): Promise<void>;
  read(options?: ReadOptions): Promise<Uint8Array>;
}
