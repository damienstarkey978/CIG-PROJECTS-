import type { AccountingProvider, AcctBill, AcctInvoice } from "./types";

const day = (offset: number, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** Demo books: fictional bills and invoices dated relative to today so the aging always looks lived in. */
export class MockAccounting implements AccountingProvider {
  readonly name = "demo_books";
  constructor(private readonly today = new Date()) {}

  async listOpenBills(): Promise<AcctBill[]> {
    const t = this.today;
    return [
      { externalId: "B1", vendorExternalId: "V1", vendorName: "Coastal Tile LLC", txnDate: day(-40, t), dueDate: day(-10, t), amount: 4200, balance: 4200, docNumber: "CT-1041", memo: "Hendricks kitchen backsplash and floor tile",
        lines: [{ description: "Tile labor", amount: 4200, account: "Subcontractors", customerRef: "Hendricks:Kitchen" }] },
      { externalId: "B2", vendorExternalId: "V2", vendorName: "Roy Electric", txnDate: day(-12, t), dueDate: day(5, t), amount: 1850.5, balance: 1850.5, docNumber: "RE-208", memo: null,
        lines: [{ description: "Rough in, 4410 Riverside Ave", amount: 1850.5, account: "Subcontractors", customerRef: null }] },
      { externalId: "B3", vendorExternalId: "V3", vendorName: "Lumber Depot", txnDate: day(-3, t), dueDate: day(27, t), amount: 960, balance: 960, docNumber: "88213", memo: "Framing lumber",
        lines: [{ description: "Lumber", amount: 960, account: "Materials", customerRef: null }] },
      { externalId: "B4", vendorExternalId: "V4", vendorName: "Sunrise Paving", txnDate: day(-75, t), dueDate: day(-45, t), amount: 7300, balance: 3650, docNumber: "SP-77", memo: "Half paid",
        lines: [{ description: "Asphalt, Stockton St", amount: 7300, account: "Subcontractors", customerRef: null }] },
    ];
  }

  async listOpenInvoices(): Promise<AcctInvoice[]> {
    const t = this.today;
    return [
      { externalId: "I1", customerExternalId: "C1", customerName: "Hendricks:Kitchen", txnDate: day(-50, t), dueDate: day(-20, t), amount: 12500, balance: 12500, docNumber: "1007" },
      { externalId: "I2", customerExternalId: "C2", customerName: "Dana Brooks", txnDate: day(-10, t), dueDate: day(20, t), amount: 8400, balance: 8400, docNumber: "1012" },
      { externalId: "I3", customerExternalId: "C3", customerName: "Alvarez, Tom", txnDate: day(-100, t), dueDate: day(-70, t), amount: 3000, balance: 1000, docNumber: "0991" },
    ];
  }
}
