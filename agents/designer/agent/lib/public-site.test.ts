import assert from "node:assert/strict";
import { test } from "node:test";
import { publicSite } from "./public-site";

// The browser opens public websites only. These are refused before any lookup.
test("the designer's browser won't open local, private, or non-web addresses", async () => {
  for (const address of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:3000",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[2002:a9fe:a9fe::1]/",
    "10.0.0.5",
    "http://localhost:4000",
    "http://printer.local",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com",
    "https://user:pass@example.com",
    "intranet",
    "",
  ]) {
    await assert.rejects(publicSite(address), /NOT_A_WEBSITE/, address);
  }
});
