# @corvid-agent/retry

Smart retry with exponential backoff, jitter, and circuit breaker pattern. Zero dependencies. TypeScript-first.

## Install

```bash
npm install @corvid-agent/retry
```

## Usage

### Basic Retry

```ts
import { retry } from "@corvid-agent/retry";

const { data, attempts } = await retry(() => fetch("/api/data"), {
  maxAttempts: 3,
  baseDelay: 1000,
});
```

### With Options

```ts
const result = await retry(() => fetchData(), {
  maxAttempts: 5,
  baseDelay: 500,
  maxDelay: 10000,
  factor: 2,
  jitter: true,
  retryIf: (err) => err instanceof NetworkError,
  onRetry: (err, attempt, delay) => {
    console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
  },
});
```

### Circuit Breaker

Prevent cascading failures by stopping requests to a failing service:

```ts
import { CircuitBreaker } from "@corvid-agent/retry";

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
});

// Normal call through breaker
const data = await breaker.call(() => fetch("/api/data"));

// Combined retry + circuit breaker
const result = await breaker.callWithRetry(
  () => fetch("/api/data"),
  { maxAttempts: 3, baseDelay: 1000 },
);
```

### Convenience Helpers

```ts
import { retryImmediate, retryLinear, withRetry } from "@corvid-agent/retry";

// No backoff, just retry immediately
const data = await retryImmediate(() => fetchData(), 3);

// Linear backoff (constant delay)
const result = await retryLinear(() => fetchData(), { baseDelay: 500 });

// Wrap any function with retry behavior
const reliableFetch = withRetry(fetch, { maxAttempts: 3 });
const response = await reliableFetch("/api/data");
```

### Abort / Cancel

```ts
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

await retry(() => slowOperation(), {
  signal: controller.signal,
});
```

## Circuit Breaker States

```
  ┌──────────┐    failure threshold    ┌──────────┐
  │  CLOSED  │ ──────────────────────> │   OPEN   │
  │ (normal) │                         │ (reject) │
  └──────────┘                         └──────────┘
       ^                                    │
       │              reset timeout         │
       │                                    v
       │                              ┌──────────┐
       └───────── success ─────────── │HALF-OPEN │
                                      │  (probe) │
                                      └──────────┘
```

## API

### `retry<T>(fn, options?): Promise<RetryResult<T>>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum retry attempts |
| `baseDelay` | `number` | `1000` | Base delay in ms |
| `maxDelay` | `number` | `30000` | Maximum delay cap |
| `factor` | `number` | `2` | Backoff multiplier |
| `jitter` | `boolean` | `true` | Randomize delays |
| `retryIf` | `(err, attempt) => boolean` | retry all | Filter retryable errors |
| `onRetry` | `(err, attempt, delay) => void` | - | Retry callback |
| `signal` | `AbortSignal` | - | Cancellation signal |

### `CircuitBreaker`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `failureThreshold` | `number` | `5` | Failures before opening |
| `resetTimeout` | `number` | `60000` | Ms before half-open |
| `halfOpenSuccesses` | `number` | `1` | Successes to close |
| `onStateChange` | `(from, to) => void` | - | State change callback |

## License

MIT
