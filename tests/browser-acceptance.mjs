// Run with the isolated Playwright package beside this file; no trace captures secrets.
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
assert.equal(process.env.MYFIN_BROWSER_ACCEPTANCE, 'myfin-phase05-20260913', 'Disposable Phase05 browser harness required');
const password = (await readFile("/run/seed", "utf8")).trim();
const evidence = "/evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  requests = [],
  failures = [];
page.on("response", (r) => {
  if (r.status() >= 400)
    failures.push({ path: new URL(r.url()).pathname, status: r.status() });
});
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => requests.push(r.url()));
const suffix = Date.now().toString(36),
  company = "Browser shop " + suffix,
  product = "Browser coffee " + suffix;
async function checkpoint(name) {
  await page.screenshot({
    path: evidence + "/" + name + ".png",
    fullPage: true,
  });
  console.log("passed:", name);
}
try {
  await page.goto("http://localhost:8080");
  await page.getByLabel("Email address").fill("operator@myfin.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await page
    .getByRole("heading", { name: "A place for every business." })
    .waitFor();
  await checkpoint("login");
  await page.getByRole("button", { name: "Enroll company", exact: true }).click();
  const enrollment = page.getByRole("dialog", { name: "Enroll a company" });
  await enrollment.getByLabel("Company name", { exact: false }).fill(company);
  await enrollment.getByRole("button", { name: "Review details" }).click();
  await enrollment.getByRole("button", { name: "Enroll company", exact: true }).click();
  await page.getByRole("dialog", { name: "Your company is ready" })
    .getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "+ Add product" }).click();
  await page.getByLabel("Product name *").fill(product);
  await page.getByLabel("Selling price (RM)").fill("9.50");
  await page.getByLabel("Cost (RM)", { exact: true }).fill("2");
  await page.getByLabel("Stock", { exact: true }).fill("12.5");
  await page
    .getByLabel("Upload photo")
    .setInputFiles({
      name: "coffee.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await page
    .getByRole("heading", { name: "New product", exact: true })
    .waitFor({ state: "hidden" });
  await checkpoint("inventory-photo");
  await page
    .getByRole("button", { name: "Edit " + product, exact: true })
    .click();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Private photo survives editing");
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await page
    .getByRole("heading", { name: "Edit product", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Resources for " + product, exact: true })
    .click();
  const sticker = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download sticker PDF" }).click();
  await (await sticker).saveAs(evidence + "/sticker.pdf");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  const csv = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export inventory" }).click();
  await (await csv).saveAs(evidence + "/inventory.csv");
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await page.getByRole("button", { name: "+ New contact" }).click();
  await page.getByLabel("Name *", { exact: true }).fill("Browser customer");
  await page.getByLabel("Email", { exact: true }).fill("browser@myfin.test");
  await page.getByRole("button", { name: "Save contact" }).click();
  await page.getByText("Browser customer", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Checkout", exact: true }).click();
  await page
    .getByRole("button", { name: "Add " + product, exact: true })
    .click();
  await page.getByRole("button", { name: /Charge RM/ }).click();
  await page.getByLabel("Cash received (RM)").fill("10");
  await page
    .getByLabel("Customer email", { exact: true })
    .fill("receipt-browser@myfin.test");
  await page
    .getByRole("button", { name: "Complete sale", exact: true })
    .click();
  await page.getByRole("heading", { name: "Order complete." }).waitFor();
  await checkpoint("pos-online");
  await page.getByRole("button", { name: "Receipt / Email" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download receipt PDF" }).click();
  await (await download).saveAs(evidence + "/receipt.pdf");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page
    .getByRole("button", { name: "Add " + product, exact: true })
    .waitFor();
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Add " + product, exact: true })
    .click();
  await page.getByRole("button", { name: /Charge RM/ }).click();
  await page.getByLabel("Cash received (RM)").fill("10");
  await page
    .getByRole("button", { name: "Complete sale", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Payment recorded. Sync pending." })
    .waitFor();
  await page.getByRole("button", { name: "New order" }).click();
  await page.reload();
  await page.getByRole("button", { name: "1 to sync" }).waitFor();
  assert.equal(await page.getByRole("button", {name:"Add "+product,exact:true}).locator("img").count(),0,"offline catalog uses its icon placeholder");
  await checkpoint("offline-reload-paid-queue");
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "1 to sync" })
    .waitFor({ state: "hidden", timeout: 30000 });
  await checkpoint("reconnected");
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Add " + product, exact: true })
    .click();
  await page.getByRole("button", { name: /Charge RM/ }).click();
  await page.getByLabel("Cash received (RM)").fill("10");
  await page
    .getByRole("button", { name: "Complete sale", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Payment recorded. Sync pending." })
    .waitFor();
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").waitFor();
  await context.setOffline(false);
  await page.waitForTimeout(1000);
  await page.getByLabel("Email address").fill("operator@myfin.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await page
    .getByRole("button", { name: "Add " + product, exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "1 to sync" })
    .waitFor({ state: "hidden", timeout: 30000 });
  await checkpoint("offline-logout-login-recovery");
  const proof = await page.evaluate(async () => {
    const co = localStorage.getItem(
      "myfin-store-" + localStorage.getItem("myfin-last-operator"),
    );
    return {
      sales: await (
        await fetch("/api/companies/" + co + "/transactions")
      ).json(),
      products: await (
        await fetch("/api/companies/" + co + "/products")
      ).json(),
    };
  });
  assert.equal(proof.sales.rows.length, 3, "three payments posted once");
  assert.equal(
    proof.products.rows[0].stock,
    9.5,
    "stock deducted exactly once per payment",
  );
  assert.equal(
    requests.some((url) => /firebase|firestore|googleapis/.test(url)),
    false,
    "no Firebase requests",
  );
  assert.deepEqual(errors, [], "no browser runtime errors");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").waitFor();
  assert.equal(
    (await page.request.get("http://localhost:8080/api/me")).status(),
    401,
    "server session revoked",
  );
  console.log("passed: logout");
} catch (e) {
  await page.screenshot({ path: evidence + "/failure.png", fullPage: true });
  console.error(
    "Browser acceptance failed:",
    e.message,
    JSON.stringify(failures),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
