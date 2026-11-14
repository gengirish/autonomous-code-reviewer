// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
"use client";

import { useEffect, useState } from "react";
import { useInvoices } from "../../hooks/useInvoices";
import { formatMoney } from "../../lib/format";
import { countOverdueInvoices } from "../../server/repositories/invoiceRepository";

interface InvoiceTableProps {
  customerId: string;
}

export function InvoiceTable({ customerId }: InvoiceTableProps) {
  const { invoices, isLoading, error } = useInvoices(customerId);
  const [overdueCount, setOverdueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    countOverdueInvoices(customerId)
      .then((count) => {
        if (!cancelled) setOverdueCount(count);
      })
      .catch(() => {
        if (!cancelled) setOverdueCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  if (isLoading) return <p role="status">Loading invoices…</p>;
  if (error) return <p role="alert">Could not load invoices.</p>;

  return (
    <section aria-labelledby="invoices-heading">
      <h2 id="invoices-heading">
        Invoices
        {overdueCount > 0 && <span className="badge badge-danger">{overdueCount} overdue</span>}
      </h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Number</th>
            <th scope="col">Due</th>
            <th scope="col">Amount</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td>{invoice.number}</td>
              <td>{invoice.dueDate.toLocaleDateString()}</td>
              <td>{formatMoney(invoice.totalCents, invoice.currency)}</td>
              <td>{invoice.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
