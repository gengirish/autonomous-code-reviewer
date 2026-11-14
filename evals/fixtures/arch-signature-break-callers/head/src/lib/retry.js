"use strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls fn until it succeeds or the attempts run out, doubling the delay each time.
 * Errors for which `shouldRetry` returns false are rethrown immediately.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.attempts=3]
 * @param {number} [options.delayMs=100] delay before the second attempt
 * @param {(err: unknown) => boolean} [options.shouldRetry]
 * @returns {Promise<T>}
 */
async function retry(fn, { attempts = 3, delayMs = 100, shouldRetry = () => true } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) throw err;
      if (i < attempts - 1) await sleep(delayMs * 2 ** i);
    }
  }
  throw lastError;
}

module.exports = { retry };
