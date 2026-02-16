import { describe, test, expect, mock } from "bun:test";
import {
  retry,
  retryImmediate,
  retryLinear,
  withRetry,
  CircuitBreaker,
  RetryError,
  CircuitOpenError,
} from "../src/index";

// ── retry() ────────────────────────────────────────────────────────────

describe("retry", () => {
  test("succeeds on first attempt", async () => {
    const result = await retry(() => 42);
    expect(result.data).toBe(42);
    expect(result.attempts).toBe(1);
  });

  test("succeeds on second attempt", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        if (calls < 2) throw new Error("fail");
        return "ok";
      },
      { baseDelay: 0, jitter: false },
    );
    expect(result.data).toBe("ok");
    expect(result.attempts).toBe(2);
  });

  test("throws RetryError after all attempts exhausted", async () => {
    try {
      await retry(() => { throw new Error("always fails"); }, {
        maxAttempts: 3,
        baseDelay: 0,
        jitter: false,
      });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(RetryError);
      const retryErr = err as RetryError;
      expect(retryErr.attempts).toBe(3);
      expect(retryErr.lastError).toBeInstanceOf(Error);
    }
  });

  test("respects maxAttempts", async () => {
    let calls = 0;
    try {
      await retry(
        () => {
          calls++;
          throw new Error("fail");
        },
        { maxAttempts: 5, baseDelay: 0, jitter: false },
      );
    } catch {
      // expected
    }
    expect(calls).toBe(5);
  });

  test("throws RangeError for maxAttempts < 1", async () => {
    try {
      await retry(() => 1, { maxAttempts: 0 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
    }
  });

  test("retryIf controls which errors are retried", async () => {
    let calls = 0;
    try {
      await retry(
        () => {
          calls++;
          throw new TypeError("not retryable");
        },
        {
          maxAttempts: 3,
          baseDelay: 0,
          retryIf: (err) => !(err instanceof TypeError),
        },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
    expect(calls).toBe(1); // should not have retried
  });

  test("onRetry is called with correct arguments", async () => {
    const retries: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;

    try {
      await retry(
        () => {
          calls++;
          throw new Error("fail");
        },
        {
          maxAttempts: 3,
          baseDelay: 100,
          jitter: false,
          onRetry: (_err, attempt, delay) => {
            retries.push({ attempt, delay });
          },
        },
      );
    } catch {
      // expected
    }

    expect(retries).toHaveLength(2); // onRetry called for attempts 1 and 2 (not 3)
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].delay).toBe(100); // base delay
    expect(retries[1].attempt).toBe(2);
    expect(retries[1].delay).toBe(200); // 100 * 2^1
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    try {
      await retry(
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          throw new Error("slow fail");
        },
        {
          maxAttempts: 10,
          baseDelay: 100,
          signal: controller.signal,
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      // Should be aborted, not RetryError
      expect(err).not.toBeInstanceOf(RetryError);
    }
  });

  test("passes attempt number to fn", async () => {
    const attempts: number[] = [];
    try {
      await retry(
        (attempt) => {
          attempts.push(attempt);
          throw new Error("fail");
        },
        { maxAttempts: 3, baseDelay: 0, jitter: false },
      );
    } catch {
      // expected
    }
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("works with async functions", async () => {
    const result = await retry(async () => {
      return Promise.resolve("async value");
    });
    expect(result.data).toBe("async value");
  });
});

// ── retryImmediate() ───────────────────────────────────────────────────

describe("retryImmediate", () => {
  test("retries without delay", async () => {
    let calls = 0;
    const start = Date.now();
    const result = await retryImmediate(() => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "done";
    }, 3);
    const elapsed = Date.now() - start;

    expect(result).toBe("done");
    expect(elapsed).toBeLessThan(100); // should be near-instant
  });
});

// ── retryLinear() ──────────────────────────────────────────────────────

describe("retryLinear", () => {
  test("uses factor=1 for linear backoff", async () => {
    const delays: number[] = [];
    let calls = 0;

    try {
      await retryLinear(
        () => {
          calls++;
          throw new Error("fail");
        },
        {
          maxAttempts: 4,
          baseDelay: 100,
          jitter: false,
          onRetry: (_err, _attempt, delay) => delays.push(delay),
        },
      );
    } catch {
      // expected
    }

    // Linear: all delays should be 100 (100 * 1^n = 100)
    expect(delays).toEqual([100, 100, 100]);
  });
});

// ── withRetry() ────────────────────────────────────────────────────────

describe("withRetry", () => {
  test("wraps a function with retry behavior", async () => {
    let calls = 0;
    const unreliable = async (msg: string): Promise<string> => {
      calls++;
      if (calls < 2) throw new Error("flaky");
      return `Hello ${msg}`;
    };

    const reliable = withRetry(unreliable, { baseDelay: 0, jitter: false });
    const result = await reliable("world");
    expect(result.data).toBe("Hello world");
    expect(result.attempts).toBe(2);
  });
});

// ── CircuitBreaker ─────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  test("starts in closed state", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe("closed");
  });

  test("passes through calls in closed state", async () => {
    const breaker = new CircuitBreaker();
    const result = await breaker.call(() => 42);
    expect(result).toBe(42);
  });

  test("opens after failure threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      try {
        await breaker.call(() => { throw new Error("fail"); });
      } catch {
        // expected
      }
    }

    expect(breaker.getState()).toBe("open");
    expect(breaker.getFailures()).toBe(3);
  });

  test("rejects calls when open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });

    try {
      await breaker.call(() => { throw new Error("fail"); });
    } catch {
      // expected
    }

    try {
      await breaker.call(() => 42);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
    }
  });

  test("transitions to half-open after reset timeout", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 50, // 50ms for testing
    });

    try {
      await breaker.call(() => { throw new Error("fail"); });
    } catch {
      // expected
    }

    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.getState()).toBe("half-open");
  });

  test("closes after success in half-open", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 50,
    });

    try {
      await breaker.call(() => { throw new Error("fail"); });
    } catch {
      // expected
    }

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.getState()).toBe("half-open");

    await breaker.call(() => "recovered");
    expect(breaker.getState()).toBe("closed");
  });

  test("reopens on failure in half-open", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 50,
    });

    try {
      await breaker.call(() => { throw new Error("fail"); });
    } catch {
      // expected
    }

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.getState()).toBe("half-open");

    try {
      await breaker.call(() => { throw new Error("fail again"); });
    } catch {
      // expected
    }

    expect(breaker.getState()).toBe("open");
  });

  test("manual reset works", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });

    try {
      await breaker.call(() => { throw new Error("fail"); });
    } catch {
      // expected
    }

    expect(breaker.getState()).toBe("open");
    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getFailures()).toBe(0);
  });

  test("onStateChange fires on transitions", async () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      onStateChange: (from, to) => transitions.push({ from, to }),
    });

    for (let i = 0; i < 2; i++) {
      try {
        await breaker.call(() => { throw new Error("fail"); });
      } catch {
        // expected
      }
    }

    expect(transitions).toEqual([{ from: "closed", to: "open" }]);
  });

  test("resets failure count on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    // Fail twice
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.call(() => { throw new Error("fail"); });
      } catch {
        // expected
      }
    }
    expect(breaker.getFailures()).toBe(2);

    // Succeed - should reset
    await breaker.call(() => "ok");
    expect(breaker.getFailures()).toBe(0);
    expect(breaker.getState()).toBe("closed");
  });

  test("callWithRetry combines retry and circuit breaker", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 10 });
    let calls = 0;

    const result = await breaker.callWithRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "success";
      },
      { maxAttempts: 5, baseDelay: 0, jitter: false },
    );

    expect(result.data).toBe("success");
    expect(result.attempts).toBe(3);
  });

  test("callWithRetry stops on circuit open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });

    try {
      await breaker.callWithRetry(
        () => { throw new Error("fail"); },
        { maxAttempts: 10, baseDelay: 0, jitter: false },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
    }
  });
});
