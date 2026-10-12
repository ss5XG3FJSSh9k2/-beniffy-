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

module.exports = { waitForSplash };
