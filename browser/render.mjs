// One page through Crawlee's PlaywrightCrawler (fingerprints on, Crawlee's default), the setup spikes.md
// §2 measured. Loaded only by the service, so its tests can stub it without starting a browser.
import { Configuration, PlaywrightCrawler } from "crawlee";

import { LayoutMissing, RenderTimeout } from "./server.mjs";

// Chromium's network timeouts (net::ERR_TIMED_OUT, ERR_CONNECTION_TIMED_OUT), Playwright's TimeoutError
// and Crawlee's "timed out after N seconds" for navigation and the handler.
const TIMED_OUT = /net::ERR_(?:CONNECTION_)?TIMED_OUT|\btimed out after\b|Timeout \d+ms exceeded/;

const TEARDOWN_MS = 10_000;
/**
 * Navigation and the waitFor wait end this long before the deadline, so their own timeouts (a slow page,
 * a missing selector: 422) are seen before the hard deadline tears the browser down (504). CI measured
 * the two firing together when both used the whole budget (2026-11-17).
 */
const MARGIN_MS = 1_500;
const after = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)).unref());

/**
 * Renders `url` and returns the status of its first response with the page's HTML after load (and after
 * `waitFor` matched, when given). A non-200 first response returns at once with an empty body. Everything,
 * browser launch included, fits before `deadline`: navigation and the handler get only the time left, and
 * at the deadline the browser is torn down (RenderTimeout), so the next render never runs beside it.
 */
export async function render({ url, waitFor, id, deadline }) {
  let status = null;
  let html = "";
  let failure = null;
  let layoutMissing = false;
  const left = () => Math.max(1, deadline - Date.now());
  const inner = () => Math.max(1, left() - MARGIN_MS);
  const secs = () => Math.max(1, Math.floor(inner() / 1000));
  const crawler = new PlaywrightCrawler(
    {
      maxRequestRetries: 0,
      maxConcurrency: 1,
      useSessionPool: false,
      persistCookiesPerSession: false,
      navigationTimeoutSecs: secs(),
      requestHandlerTimeoutSecs: secs(),
      launchContext: { launchOptions: { headless: true } },
      preNavigationHooks: [
        async (_ctx, gotoOptions) => {
          gotoOptions.waitUntil = "load";
          gotoOptions.timeout = inner();
        },
      ],
      postNavigationHooks: [
        async ({ response }) => {
          if (!response) return;
          // The first hop: a redirect answers with its 3xx, the page with its own status.
          let first = response.request();
          while (first.redirectedFrom()) first = first.redirectedFrom();
          const firstResponse = first === response.request() ? response : await first.response();
          status = firstResponse?.status() ?? response.status();
        },
      ],
      async requestHandler({ page }) {
        if (status !== 200) return;
        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: inner() });
          } catch (e) {
            // The page itself loaded (status 200): a selector that never shows is a layout change.
            if (e?.name === "TimeoutError") layoutMissing = true;
            throw e;
          }
        }
        html = await page.content();
      },
      failedRequestHandler(_ctx, error) {
        failure = error;
      },
    },
    new Configuration({ persistStorage: false, purgeOnStart: true }),
  );
  const run = crawler.run([{ url, uniqueKey: id }]);
  const outcome = await Promise.race([run.then(() => "done", (e) => ((failure ??= e), "done")), after(left()).then(() => "deadline")]);
  // Close the browser either way; at the deadline this also ends the stuck navigation. Bounded, so a
  // hanging teardown cannot hold the queue for good.
  await Promise.race([crawler.teardown().catch(() => {}), after(TEARDOWN_MS)]);
  if (outcome === "deadline") {
    await Promise.race([run.catch(() => {}), after(TEARDOWN_MS)]);
    throw new RenderTimeout(`${new URL(url).host} did not settle`);
  }
  if (status !== null && status !== 200) return { status, html: "" };
  if (layoutMissing) throw new LayoutMissing(`${new URL(url).host}: ${waitFor} never appeared`);
  if (failure) {
    const timedOut = failure.name === "TimeoutError" || TIMED_OUT.test(String(failure.message));
    if (timedOut) throw new RenderTimeout(`${new URL(url).host} did not settle`);
    throw failure;
  }
  if (status === null) throw new Error("no response");
  return { status, html };
}
