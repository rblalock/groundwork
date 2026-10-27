// The Content Security Policy a business's own customer page is served with (core/customer-page-template.ts):
// no script at all, styles inline or from Google Fonts, images from this site (the logo) or inline, and
// forms that post only here (on to Stripe's checkout for Pay). Its own module so next.config.ts can set
// it on the pages' routes without loading the template code.
export const CUSTOMER_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
