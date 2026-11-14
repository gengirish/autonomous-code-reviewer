"use strict";

const { retry } = require("../lib/retry");
const logger = require("../lib/logger");

async function reserveStock(warehouse, sku, qty) {
  logger.debug("reserving stock", { sku, qty, warehouse: warehouse.id });
  return retry(() => warehouse.reserve(sku, qty), 5, 250);
}

async function releaseStock(warehouse, reservationId) {
  logger.debug("releasing stock", { reservationId, warehouse: warehouse.id });
  await warehouse.release(reservationId);
}

module.exports = { reserveStock, releaseStock };
