import type { Language } from "./language";

export type PdfCopy = {
  quote: string;
  preparedFor: string;
  preparedBy: string;
  service: string;
  qty: string;
  unit: string;
  amount: string;
  subtotal: string;
  minimumAdjustment: string;
  discount: string;
  override: string;
  tax: (ratePercent: string) => string;
  total: string;
  validUntil: string;
  notes: string;
  photos: string;
  /** Heading over the work's photos on an invoice. */
  workPhotos: string;
  /** Heading over the quote's before-and-after on an invoice. */
  beforeAfter: string;
  license: string;
  revision: (n: number) => string;
  draftWatermark: string;
  thanks: string;
  invoice: string;
  billTo: string;
  invoiceDate: string;
  dueDate: string;
  dueOnReceipt: string;
  paid: string;
  balanceDue: string;
  payOnline: string;
  payOnlineHelp: string;
  approveOnline: string;
  approveOnlineHelp: string;
  paidWatermark: string;
  invoiceThanks: string;
  receipt: string;
  receiptFor: (label: string) => string;
  receivedFrom: string;
  date: string;
  method: string;
  methods: Record<"cash" | "check" | "card" | "other", string>;
  invoiceTotal: string;
  paidInFull: string;
};

const EN: PdfCopy = {
  quote: "Quote",
  preparedFor: "Prepared for",
  preparedBy: "Prepared by",
  service: "Service",
  qty: "Qty",
  unit: "Unit price",
  amount: "Amount",
  subtotal: "Subtotal",
  minimumAdjustment: "Minimum visit adjustment",
  discount: "Discount",
  override: "Price adjustment",
  tax: (ratePercent) => `Tax (${ratePercent}%)`,
  total: "Total",
  validUntil: "Valid until",
  notes: "Notes",
  photos: "Photos",
  workPhotos: "Completed work",
  beforeAfter: "Before and after",
  license: "License",
  revision: (n) => `Revision ${n}`,
  draftWatermark: "DRAFT",
  thanks: "Thank you for the opportunity to quote this work.",
  invoice: "Invoice",
  billTo: "Bill to",
  invoiceDate: "Invoice date",
  dueDate: "Due",
  dueOnReceipt: "Due on receipt",
  paid: "Paid",
  balanceDue: "Balance due",
  payOnline: "Pay online",
  payOnlineHelp: "Pay the balance by card at this link:",
  approveOnline: "Approve online",
  approveOnlineHelp: "Approve this quote at this link:",
  paidWatermark: "PAID",
  invoiceThanks: "Thank you for your business.",
  receipt: "Receipt",
  receiptFor: (label) => `For invoice ${label}`,
  receivedFrom: "Received from",
  date: "Date",
  method: "Method",
  methods: { cash: "Cash", check: "Check", card: "Card", other: "Other" },
  invoiceTotal: "Invoice total",
  paidInFull: "Paid in full",
};

const ES: PdfCopy = {
  quote: "Presupuesto",
  preparedFor: "Preparado para",
  preparedBy: "Preparado por",
  service: "Servicio",
  qty: "Cant.",
  unit: "Precio unitario",
  amount: "Importe",
  subtotal: "Subtotal",
  minimumAdjustment: "Ajuste por visita mínima",
  discount: "Descuento",
  override: "Ajuste de precio",
  tax: (ratePercent) => `Impuesto (${ratePercent}%)`,
  total: "Total",
  validUntil: "Válido hasta",
  notes: "Notas",
  photos: "Fotos",
  workPhotos: "Trabajo realizado",
  beforeAfter: "Antes y después",
  license: "Licencia",
  revision: (n) => `Revisión ${n}`,
  draftWatermark: "BORRADOR",
  thanks: "Gracias por la oportunidad de cotizar este trabajo.",
  invoice: "Factura",
  billTo: "Facturar a",
  invoiceDate: "Fecha",
  dueDate: "Vence",
  dueOnReceipt: "Vence al recibirla",
  paid: "Pagado",
  balanceDue: "Saldo pendiente",
  payOnline: "Pagar en línea",
  payOnlineHelp: "Pague el saldo con tarjeta en este enlace:",
  approveOnline: "Aprobar en línea",
  approveOnlineHelp: "Apruebe esta cotización en este enlace:",
  paidWatermark: "PAGADA",
  invoiceThanks: "Gracias por su preferencia.",
  receipt: "Recibo",
  receiptFor: (label) => `De la factura ${label}`,
  receivedFrom: "Recibido de",
  date: "Fecha",
  method: "Método",
  methods: { cash: "Efectivo", check: "Cheque", card: "Tarjeta", other: "Otro" },
  invoiceTotal: "Total de la factura",
  paidInFull: "Pagada por completo",
};

export function pdfCopy(language: Language): PdfCopy {
  return language === "es" ? ES : EN;
}
