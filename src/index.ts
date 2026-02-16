/**
 * @corvid-agent/retry
 *
 * Smart retry with exponential backoff, jitter, and circuit breaker pattern.
 * Zero dependencies. TypeScript-first.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms between retries (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in ms (caps exponential growth, default: 30000) */
  maxDelay?: number;
  /** Backoff multiplier (default: 2) */
  factor?: number;
  /** Add randomized jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Only retry if this returns true for the error (default: retry all) */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry attempt */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface RetryResult<T> {
  data: T;
  attempts: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms to wait before trying half-open (default: 60000) */
  resetTimeout?: number;
  /** Number of successes in half-open to close circuit (default: 1) */
  halfOpenSuccesses?: number;
  /** Called when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class CircuitOpenError extends Error {
  readonly state: CircuitState;
  readonly failures: number;

  constructor(failures: number) {
    super(`Circuit breaker is open after ${failures} failures`);
    this.name = "CircuitOpenError";
    this.state = "open";
    this.failures = failures;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function computeDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  factor: number,
  jitter: boolean,
): number {
  const exponential = baseDelay * Math.pow(factor, attempt - 1);
  const capped = Math.min(exponential, maxDelay);
  if (!jitter) return capped;
  // Full jitter: random value between 0 and capped delay
  return Math.floor(Math.random() * capped);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// ── Core retry ─────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff.
 *
 * @example
 * ```ts
 * import { retry } from "@corvid-agent/retry";
 *
 * const result = await retry(() => fetch("https://api.example.com/data"), {
 *   maxAttempts: 3,
 *   baseDelay: 1000,
 *   onRetry: (err, attempt) => console.log(`Retry ${attempt}...`),
 * });
 * ```
 */
export async function retry<T>(
  fn: (attempt: number) => T | Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 30_000,
    factor = 2,
    jitter = true,
    retryIf,
    onRetry,
    signal,
  } = options;

  if (maxAttempts < 1) {
    throw new RangeError("maxAttempts must be >= 1");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      const data = await fn(attempt);
      return { data, attempts: attempt };
    } catch (error) {
      lastError = error;

      // Don't retry if this was an abort
      if (signal?.aborted) {
        throw error;
      }

      // Check if we should retry this error
      if (retryIf && !retryIf(error, attempt)) {
        throw error;
      }

      // If this was the last attempt, don't retry
      if (attempt === maxAttempts) {
        break;
      }

      const delay = computeDelay(attempt, baseDelay, maxDelay, factor, jitter);
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }

  throw new RetryError(
    `All ${maxAttempts} attempts failed`,
    maxAttempts,
    lastError,
  );
}

// ── Circuit Breaker ────────────────────────────────────────────────────

/**
 * Circuit breaker that wraps an async function.
 * Prevents cascading failures by "opening" after repeated failures.
 *
 * States:
 * - **closed**: Normal operation, requests pass through
 * - **open**: Requests are rejected immediately
 * - **half-open**: A limited number of requests pass through to test recovery
 *
 * @example
 * ```ts
 * import { CircuitBreaker } from "@corvid-agent/retry";
 *
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 5,
 *   resetTimeout: 30000,
 * });
 *
 * const result = await breaker.call(() => fetch("/api/data"));
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly halfOpenSuccesses: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 60_000;
    this.halfOpenSuccesses = options.halfOpenSuccesses ?? 1;
    this.onStateChange = options.onStateChange;
  }

  /** Current circuit state */
  getState(): CircuitState {
    this.checkHalfOpen();
    return this.state;
  }

  /** Number of consecutive failures */
  getFailures(): number {
    return this.failures;
  }

  /** Manually reset the circuit to closed state */
  reset(): void {
    this.transition("closed");
    this.failures = 0;
    this.successes = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async call<T>(fn: () => T | Promise<T>): Promise<T> {
    this.checkHalfOpen();

    if (this.state === "open") {
      throw new CircuitOpenError(this.failures);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Combine circuit breaker with retry.
   * Retries the function, but respects circuit breaker state.
   */
  async callWithRetry<T>(
    fn: (attempt: number) => T | Promise<T>,
    retryOptions: RetryOptions = {},
  ): Promise<RetryResult<T>> {
    return retry(
      async (attempt) => {
        return this.call(() => fn(attempt));
      },
      {
        ...retryOptions,
        retryIf: (error, attempt) => {
          // Don't retry if circuit is open
          if (error instanceof CircuitOpenError) return false;
          return retryOptions.retryIf?.(error, attempt) ?? true;
        },
      },
    );
  }

  private checkHalfOpen(): void {
    if (
      this.state === "open" &&
      Date.now() - this.lastFailureTime >= this.resetTimeout
    ) {
      this.transition("half-open");
      this.successes = 0;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.halfOpenSuccesses) {
        this.transition("closed");
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      this.transition("open");
    } else if (this.failures >= this.failureThreshold) {
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    if (this.state !== to) {
      const from = this.state;
      this.state = to;
      this.onStateChange?.(from, to);
    }
  }
}

// ── Convenience helpers ────────────────────────────────────────────────

/**
 * Retry with a simple count — no backoff, just immediate retries.
 * Good for idempotent operations that may have transient failures.
 */
export async function retryImmediate<T>(
  fn: (attempt: number) => T | Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const result = await retry(fn, {
    maxAttempts,
    baseDelay: 0,
    jitter: false,
  });
  return result.data;
}

/**
 * Retry with linear backoff instead of exponential.
 */
export async function retryLinear<T>(
  fn: (attempt: number) => T | Promise<T>,
  options: Omit<RetryOptions, "factor"> = {},
): Promise<RetryResult<T>> {
  return retry(fn, { ...options, factor: 1 });
}

/**
 * Create a retryable version of any async function.
 */
export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: RetryOptions = {},
): (...args: TArgs) => Promise<RetryResult<TReturn>> {
  return (...args: TArgs) => retry(() => fn(...args), options);
}
