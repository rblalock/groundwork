// Shared by the customer page tests: small templates for each page.

/** A small invoice page template, colored so versions tell apart. */
export const invoicePage = (color: string) =>
  `<!doctype html><html><head><title>{{en:Invoice|es:Factura}}</title><style>body{color:${color}}</style></head><body><h1>{{business.name}}</h1><p>{{invoice.balance}}</p>{{invoice.action}}</body></html>`;

/** A small quote page template. */
export const quotePage = (color: string) =>
  `<!doctype html><html><head><title>{{en:Quote|es:Cotización}}</title><style>body{color:${color}}</style></head><body><h1>{{quote.title}}</h1>{{quote.items}}<p>{{en:Total|es:Total}} {{quote.total}}</p>{{quote.action}}{{quote.receipt}}</body></html>`;
