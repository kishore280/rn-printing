import {
  decorrelatedJitterGenerator,
  ExponentialBackoff,
  handleWhen,
  noJitterGenerator,
  retry,
  type RetryPolicy,
} from 'cockatiel';
import { NativeModuleMissingError, TransportError, UnsupportedPlatformError } from './errors';

/**
 * Connect retry. This is a thin layer over `cockatiel` (MIT, a TypeScript port of
 * Polly): its RetryPolicy and ExponentialBackoff do the work. The backoff uses
 * decorrelated jitter by default, the strategy that cockatiel and Polly recommend.
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export interface ReconnectOptions {
  /** Total connect attempts, including the first. 1 = no retry. Default 3. */
  maxAttempts?: number | undefined;
  /** Wait before the first retry, in ms. Default 300. */
  initialDelayMs?: number | undefined;
  /** The wait grows by this factor. Default 2. */
  backoffMultiplier?: number | undefined;
  /** The wait never goes above this. Default 2000. */
  maxDelayMs?: number | undefined;
  /** Random spread of the wait (decorrelated jitter). Default true. Set false for fixed waits. */
  jitter?: boolean | undefined;
  /**
   * If a write fails after some bytes may have gone out, reconnect and send the
   * whole job again. Default false, because the job could print twice.
   */
  resendAfterPartialWrite?: boolean | undefined;
}

export type ConnectionEvent =
  | { type: 'connecting'; attempt: number; maxAttempts: number }
  | { type: 'retry'; attempt: number; delayMs: number; error: Error }
  | { type: 'connected'; attempt: number }
  | { type: 'failed'; attempts: number; error: Error };

export type ResolvedReconnect = { [K in keyof ReconnectOptions]-?: NonNullable<ReconnectOptions[K]> };

export function resolveReconnect(o: ReconnectOptions | boolean | undefined): ResolvedReconnect {
  const base: ResolvedReconnect = {
    maxAttempts: 3,
    initialDelayMs: 300,
    backoffMultiplier: 2,
    maxDelayMs: 2000,
    jitter: true,
    resendAfterPartialWrite: false,
  };
  if (o === false) return { ...base, maxAttempts: 1 };
  if (o === true || o === undefined) return base;
  const out = { ...base };
  for (const k of Object.keys(o) as Array<keyof ReconnectOptions>) {
    const v = o[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (!Number.isInteger(out.maxAttempts) || out.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer of 1 or more');
  }
  return out;
}

/** Codes where a new attempt can help. Everything else needs the user to act (permission, Bluetooth off, wrong address). */
const TRANSIENT = new Set(['E_CONNECT', 'E_NOT_CONNECTED', 'E_TIMEOUT', 'E_WRITE', 'E_READ', 'E_DISCONNECTED', 'E_DISCOVERY']);

export function isTransient(e: unknown): boolean {
  if (e instanceof UnsupportedPlatformError || e instanceof NativeModuleMissingError) return false;
  if (e instanceof TransportError) return e.code === undefined || TRANSIENT.has(e.code);
  return true;
}

/**
 * Build the retry policy. cockatiel's `maxAttempts` counts RETRIES (not the first
 * try), so it is `maxAttempts - 1` here.
 */
export function connectPolicy(o: ResolvedReconnect, emit: (e: ConnectionEvent) => void): RetryPolicy {
  const shape = { initialDelay: o.initialDelayMs, maxDelay: o.maxDelayMs, exponent: o.backoffMultiplier };
  const backoff = o.jitter
    ? new ExponentialBackoff({ ...shape, generator: decorrelatedJitterGenerator })
    : new ExponentialBackoff({ ...shape, generator: noJitterGenerator });
  const policy = retry(
    handleWhen((e) => isTransient(e)),
    { maxAttempts: o.maxAttempts - 1, backoff }
  );
  policy.onRetry((r) => {
    const error = 'error' in r ? r.error : new Error('Retry on result');
    emit({ type: 'retry', attempt: r.attempt, delayMs: r.delay, error });
  });
  return policy;
}

/** Run `connect` through the retry policy. Emits events for the app. */
export async function connectWithRetry(
  connect: () => Promise<void>,
  o: ResolvedReconnect,
  emit: (e: ConnectionEvent) => void
): Promise<void> {
  const policy = connectPolicy(o, emit);
  let attempt = 0;
  try {
    await policy.execute(async () => {
      attempt++;
      emit({ type: 'connecting', attempt, maxAttempts: o.maxAttempts });
      await connect();
    });
    emit({ type: 'connected', attempt });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    emit({ type: 'failed', attempts: attempt, error });
    throw error;
  }
}
