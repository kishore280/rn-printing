export interface ReadOptions {
  /** Stop after this many ms in total. Default 1500. */
  timeoutMs?: number;
  /** After the first data arrives, stop when no data arrives for this many ms. Default 150. */
  idleMs?: number;
  /** Stop after this many bytes. 0 means no limit. Default 0. */
  maxBytes?: number;
}

/** The part of `AbortSignal` that this package uses. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Options of one write. A transport that cannot stop between pieces ignores `signal`. */
export interface WriteOptions {
  /** Abort to stop a long write between pieces. The write rejects with code E_CANCELLED. */
  signal?: AbortSignalLike | undefined;
  /** Called after each piece. */
  onProgress?: ((sentBytes: number, totalBytes: number) => void) | undefined;
}

/** Life cycle of a link: `connecting` > `connected` > `writing` > `connected` ... > `disconnecting` > `disconnected`. */
export type LinkState = 'connecting' | 'connected' | 'writing' | 'disconnecting' | 'disconnected';

/** One change of the link. A lost link, a failed write and a failed connect end in `disconnected`, with the reason. */
export interface LinkEvent {
  state: LinkState;
  /** Why the link closed. Set when `state` is 'disconnected'. 'requested' = we closed it. */
  reason?: string | undefined;
  /** The error that ended the link, when there was one. */
  error?: Error | undefined;
}

/** A byte pipe to the printer. */
export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  write(data: Uint8Array, options?: WriteOptions): Promise<void>;
  read(options?: ReadOptions): Promise<Uint8Array>;
  /** Optional. The state of the link now. A transport that cannot tell leaves it out. */
  readonly connectionState?: LinkState;
  /** Optional. Be told when the link changes. Returns a function that removes the listener. */
  onConnectionState?(listener: (event: LinkEvent) => void): () => void;
  /** Optional. Stop the write that runs now, between two pieces. */
  cancel?(): void;
}
