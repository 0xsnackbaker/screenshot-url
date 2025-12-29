#!/usr/bin/env node
import axios from "axios";
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "fs";
import { chromium, type Browser } from "playwright-core";
import { withPaymentInterceptor, type Hex } from "x402-axios";

const url = process.argv[2];

if (!url) {
  console.error("Usage: npx screenshot-url <url>");
  console.error("Example: npx screenshot-url https://www.cnn.com/");
  process.exit(1);
}

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as Hex;

if (!evmPrivateKey) {
  console.error("Error: EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

async function main(): Promise<void> {
  let browser: Browser | null = null;

  try {
    console.log(`Taking screenshot of: ${url}`);

    // Create Base signer from private key
    const account = privateKeyToAccount(evmPrivateKey);

    // Create axios instance with payment interceptor
    const api = withPaymentInterceptor(
      axios.create({
        baseURL: "https://x402.browserbase.com",
      }),
      account as never
    );

    // Create browserbase session (5 minute minimum)
    console.log("Creating browser session...");
    const response = await api.post("/browser/session/create", {
      estimatedMinutes: 5,
    });

    const connectUrl = response.data?.connectUrl;
    if (!connectUrl) {
      console.error("No connectUrl in response");
      process.exit(1);
    }

    console.log("Connecting to browser...");
    browser = await chromium.connectOverCDP(connectUrl);

    const defaultContext = browser.contexts()[0];
    const page = defaultContext.pages()[0];

    // Set larger viewport for high quality
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Navigate to URL
    console.log("Loading page...");
    await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });

    // Wait for initial content
    await page.waitForTimeout(3000);

    // Try to click accept/agree buttons for consent
    console.log("Handling consent dialogs...");
    const consentButtons = [
      'button:has-text("Accept All")',
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      'button:has-text("I Agree")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      '#onetrust-accept-btn-handler',
      '.accept-cookies',
      '[data-testid="accept-button"]',
    ];

    for (const selector of consentButtons) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`  Clicked: ${selector}`);
          await page.waitForTimeout(1000);
          break;
        }
      } catch {
        // Continue to next selector
      }
    }

    // Remove only specific known consent overlays (not general modals)
    await page.evaluate(() => {
      const specificSelectors = [
        '#onetrust-consent-sdk',
        '#onetrust-banner-sdk',
        '.onetrust-pc-dark-filter',
        '.evidon-banner',
        '.cc-banner',
        '.cookie-banner',
        '.gdpr-banner',
        '[class*="CookieBanner"]',
        '[class*="ConsentBanner"]',
      ];

      specificSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove());
      });

      // Reset body scroll in case it was locked
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.documentElement.style.overflow = '';
    });

    await page.waitForTimeout(500);

    // Scroll down the page to trigger lazy loading - re-check height as we go
    console.log("Scrolling to load all content...");
    let previousHeight = 0;
    let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    let scrollPosition = 0;
    const step = 800;

    while (scrollPosition < currentHeight || currentHeight > previousHeight) {
      previousHeight = currentHeight;
      scrollPosition += step;

      await page.evaluate((pos) => window.scrollTo({ top: pos, behavior: 'instant' }), scrollPosition);
      await page.waitForTimeout(500);

      currentHeight = await page.evaluate(() => document.body.scrollHeight);

      // Safety limit
      if (scrollPosition > 50000) break;
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Take full page screenshot
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `screenshot-${timestamp}.png`;

    console.log("Capturing full page screenshot...");
    await page.screenshot({
      path: filename,
      fullPage: true,
      type: "png",
    });

    console.log(`Screenshot saved: ${filename}`);
  } catch (error: any) {
    console.error("Error:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Browser may already be closed
      }
    }
  }
}

main();
