/**
 * FAST Missions Bot
 * Walks the shop.fast.xyz agent checkout path for each merchant mission
 * and captures the 6 required screenshots per mission.
 *
 * SAFETY: the bot NEVER enters payment data and NEVER clicks a final
 * "Pay" button. It always stops at the last safe point before payment
 * (mission step 6). The optional "complete purchase" bonus step is
 * intentionally NOT implemented.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SHOP_URL = "https://shop.fast.xyz/";
const merchants = require("../config/merchants.json");

const OUT_DIR = path.join(__dirname, "..", "screenshots");
const CHAT_INPUT = '[placeholder="Search for something to buy"]';
const SEND_BUTTON = 'button[type="submit"]';

// Words that mean "final payment action" — the bot must never click these.
const FORBIDDEN_CLICK = /\b(pay now|place order|complete purchase|confirm payment|pagar|finalizar compra)\b/i;
// Payment-ish inputs the bot must never fill.
const FORBIDDEN_INPUT = /(card|cvv|cvc|expiry|expiration|iban|account.?number)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, dir, name) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  [shot] ${file}`);
}

async function dismissCookieBanner(page) {
  // Privacy-preserving choice: essential cookies only.
  const btn = page.getByRole("button", { name: /essential only/i });
  if (await btn.count()) {
    await btn.first().click().catch(() => {});
    await sleep(500);
  }
}

async function waitForAssistantReply(page, timeoutMs = 90_000) {
  // Wait until the page stops producing new text (assistant streamed reply).
  const start = Date.now();
  let prevLen = 0;
  let stableTicks = 0;
  while (Date.now() - start < timeoutMs) {
    const len = (await page.textContent("body").catch(() => "") || "").length;
    stableTicks = len === prevLen && len > 0 ? stableTicks + 1 : 0;
    prevLen = len;
    if (stableTicks >= 4) return; // ~4s of no change → reply finished
    await sleep(1000);
  }
}

async function clickFirstProduct(page) {
  // Heuristics: product cards in the chat results are links/buttons with an
  // image or a price. Try several selectors, most specific first.
  const candidates = [
    '[data-testid*="product"]',
    'a[href*="product"]',
    "article a",
    'img[alt]:not([alt=""])',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const text = (await el.textContent().catch(() => "")) || "";
      if (!FORBIDDEN_CLICK.test(text)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return sel;
      }
    }
  }
  // Fallback: any element showing a price.
  const priced = page.locator("text=/[$€R]\\s?\\d+[.,]?\\d*/").first();
  if (await priced.count()) {
    await priced.click({ timeout: 5000 }).catch(() => {});
    return "price-element";
  }
  return null;
}

async function beginCheckout(page) {
  // Click "checkout"-ish controls, but never a final payment control.
  const labels = [/add to cart/i, /buy/i, /checkout/i, /continue/i];
  for (const re of labels) {
    const btn = page.getByRole("button", { name: re }).or(page.getByRole("link", { name: re }));
    if (await btn.count()) {
      const text = (await btn.first().textContent().catch(() => "")) || "";
      if (FORBIDDEN_CLICK.test(text)) continue; // safety guard
      await btn.first().click({ timeout: 5000 }).catch(() => {});
      await sleep(2000);
    }
  }
}

async function assertNoPaymentEntered(page) {
  // Defensive check: make sure no payment-looking input has a value.
  const inputs = page.locator("input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const name = `${await el.getAttribute("name")} ${await el.getAttribute("id")} ${await el.getAttribute("placeholder")}`;
    if (FORBIDDEN_INPUT.test(name)) {
      const val = await el.inputValue().catch(() => "");
      if (val) throw new Error(`SAFETY VIOLATION: payment field has a value (${name})`);
    }
  }
}

async function runMission(browser, merchant) {
  console.log(`\n=== Mission: ${merchant.name} (${merchant.site}) ===`);
  const dir = path.join(OUT_DIR, merchant.slug);
  fs.mkdirSync(dir, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    // Step 1 — open shop.fast.xyz
    await page.goto(SHOP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dismissCookieBanner(page);
    await shot(page, dir, "01-homepage");

    // Step 2 — chatbot (Pif assistant panel)
    await page.locator(CHAT_INPUT).first().click({ timeout: 15_000 });
    await shot(page, dir, "02-chatbot-open");

    // Step 3 — search with the exact mission prompt
    await page.locator(CHAT_INPUT).first().fill(merchant.prompt);
    await page.locator(SEND_BUTTON).first().click();
    await waitForAssistantReply(page);
    await shot(page, dir, "03-search-results");

    // Step 4 — select a product
    const used = await clickFirstProduct(page);
    console.log(`  [product] selector: ${used}`);
    await sleep(3000);
    await shot(page, dir, "04-product-detail");

    // Step 5 — begin checkout (no private payment data — the bot types nothing here)
    await beginCheckout(page);
    await shot(page, dir, "05-checkout");

    // Step 6 — STOP before payment
    await assertNoPaymentEntered(page);
    await shot(page, dir, "06-stop-before-payment");

    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          merchant: merchant.name,
          site: merchant.site,
          prompt: merchant.prompt,
          finishedAt: new Date().toISOString(),
          device: "Linux server (headless)",
          browser: `Chromium ${browser.version()}`,
          notes: "Automated run. No payment data entered. Stopped before payment.",
        },
        null,
        2
      )
    );
    console.log(`  [done] ${merchant.name}`);
    return { merchant: merchant.slug, ok: true };
  } catch (err) {
    console.error(`  [fail] ${merchant.name}: ${err.message}`);
    await shot(page, dir, "error").catch(() => {});
    return { merchant: merchant.slug, ok: false, error: err.message };
  } finally {
    await ctx.close();
  }
}

(async () => {
  const only = process.argv[2]; // optional: run a single merchant by slug
  const list = only ? merchants.filter((m) => m.slug === only) : merchants;
  if (!list.length) {
    console.error(`No merchant matches "${only}". Slugs: ${merchants.map((m) => m.slug).join(", ")}`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const m of list) results.push(await runMission(browser, m));
  await browser.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2));
  console.log("\nSummary:", results.map((r) => `${r.merchant}:${r.ok ? "ok" : "FAIL"}`).join(" "));
})();
