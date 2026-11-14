"use strict";

const { retry } = require("../lib/retry");
const logger = require("../lib/logger");

/** Declines are final: retrying a declined card only produces duplicate declines. */
const isTransient = (err) => err.code !== "card_declined" && err.code !== "insufficient_funds";

async function capturePayment(gateway, paymentId) {
  const result = await retry(() => gateway.capture(paymentId), {
    attempts: 4,
    delayMs: 300,
    shouldRetry: isTransient,
  });
  logger.info("payment captured", { paymentId, amount: result.amount });
  return result;
}

module.exports = { capturePayment };
