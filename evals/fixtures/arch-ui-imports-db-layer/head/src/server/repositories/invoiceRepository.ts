// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { prisma } from "../db";
import type { Invoice } from "../../types/billing";

export async function listInvoices(customerId: string): Promise<Invoice[]> {
  return prisma.invoice.findMany({
    where: { customerId },
    orderBy: { dueDate: "desc" },
  });
}

export async function countOverdueInvoices(customerId: string, now: Date = new Date()): Promise<number> {
  return prisma.invoice.count({
    where: { customerId, status: "open", dueDate: { lt: now } },
  });
}
