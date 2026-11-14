// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";

export const ordersRouter = Router();

const OrderIdParams = z.object({ id: z.string().uuid() });

const SORTABLE_COLUMNS = ["created_at", "total_cents", "status"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

ordersRouter.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const sort =
      typeof req.query.sort === "string" && SORTABLE_COLUMNS.includes(req.query.sort) ? req.query.sort : "created_at";
    const requested = Number.parseInt(String(req.query.limit ?? DEFAULT_PAGE_SIZE), 10);
    const limit = Math.min(Math.max(requested || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    let sql = "SELECT id, status, total_cents, created_at FROM orders WHERE customer_id = $1";
    if (status) {
      sql += ` AND status = '${status}'`;
    }
    sql += ` ORDER BY ${sort} DESC LIMIT ${limit}`;

    const { rows } = await pool.query(sql, [req.user.customerId]);
    res.json({ orders: rows });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/orders/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = OrderIdParams.parse(req.params);
    const { rows } = await pool.query(
      "SELECT id, status, total_cents, created_at FROM orders WHERE id = $1 AND customer_id = $2",
      [id, req.user.customerId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
