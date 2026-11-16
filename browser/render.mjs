// One page through Crawlee's PlaywrightCrawler (fingerprints on, Crawlee's default), the setup spikes.md
// §2 measured. Loaded only by the service, so its tests can stub it without starting a browser.
import { Configuration, PlaywrightCrawler } from "crawlee";

import { RenderTimeout } from "./server.mjs";

// Chromium's network timeouts (net::ERR_TIMED_OUT, ERR_CONNECTION_TIMED_OUT), Playwright's TimeoutError
// and Crawlee's "timed out after N seconds" for navigation and the handler.
const TIMED_OUT = /net::ERR_(?:CONNECTION_)?TIMED_OUT|\btimed out after\b|Timeout \d+ms exceeded/;

/**
 * Renders `url` and returns the status of its first response with the page's HTML after load (and after
 * `waitFor` matched, when given). A non-200 first response returns at once with an empty body.
 */
export async function render({ url, timeoutMs, waitFor, id }) {
  let status = null;
  let html = "";
  let failure = null;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const crawler = new PlaywrightCrawler(
    {
      maxRequestRetries: 0,
      maxConcurrency: 1,
      useSessionPool: false,
      persistCookiesPerSession: false,
      navigationTimeoutSecs: Math.ceil(timeoutMs / 1000),
      requestHandlerTimeoutSecs: Math.ceil(timeoutMs / 1000),
      launchContext: { launchOptions: { headless: true } },
      preNavigationHooks: [
        async (_ctx, gotoOptions) => {
          gotoOptions.waitUntil = "load";
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
        if (waitFor) await page.waitForSelector(waitFor, { timeout: left() });
        html = await page.content();
      },
      failedRequestHandler(_ctx, error) {
        failure = error;
      },
    },
    new Configuration({ persistStorage: false, purgeOnStart: true }),
  );
  try {
    await crawler.run([{ url, uniqueKey: id }]);
  } finally {
    await crawler.teardown();
  }
  if (status !== null && status !== 200) return { status, html: "" };
  if (failure) {
    const timedOut = failure.name === "TimeoutError" || TIMED_OUT.test(String(failure.message));
    if (timedOut) throw new RenderTimeout(`${new URL(url).host} did not settle`);
    throw failure;
  }
  if (status === null) throw new Error("no response");
  return { status, html };
}
