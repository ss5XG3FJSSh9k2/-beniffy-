async function waitForSplash(page) {
  // Splash max duration is 1900ms + 320ms transition = ~2220ms. Wait up to 3000ms for it to disappear.
  const splash = page.locator('.cs-splash');
  if (await splash.count() > 0) {
    try {
      await splash.waitFor({ state: 'hidden', timeout: 3500 });
    } catch (e) {
      // Ignore if it's already gone
    }
  }
}



async function newLightContext(browser, options = {}) {
  return await browser.newContext({ colorScheme: 'light', ...options });
}
async function newLightPage(browser, options = {}) {
  const ctx = await newLightContext(browser, options);
  return await ctx.newPage();
}
module.exports = { waitForSplash, newLightContext, newLightPage };
