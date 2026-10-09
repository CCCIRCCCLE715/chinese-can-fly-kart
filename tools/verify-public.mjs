import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';

const url = process.argv[2] || 'https://cccircccle715.github.io/kart-royale-cn/';
const options = { headless: true, args: ['--enable-webgl', '--use-angle=metal', '--ignore-gpu-blocklist'] };
if (process.env.CHROME_PATH) options.executablePath = process.env.CHROME_PATH;
const browser = await puppeteer.launch(options);
try {
  const page = await browser.newPage();
  const errors = [], failed = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', response => { if (response.status() >= 400) failed.push({ url: response.url(), status: response.status() }); });
  page.on('requestfailed', request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__gameReady, { timeout: 240000 });
  const initial = await page.evaluate(() => {
    const c = window.__ctx;
    return { title: document.title, racers: c.race.karts.length,
      importedPlayer: !!c.race.player.object.getObjectByName('player_SU7_108'),
      town: !!c.scene.getObjectByName('imported-japanese-town'),
      logo: Array.from(document.images).filter(image => image.getAttribute('src')).every(image => image.complete && image.naturalWidth > 0) };
  });
  assert.equal(initial.racers, 8); assert.equal(initial.importedPlayer, true);
  assert.equal(initial.town, true); assert.equal(initial.logo, true);
  await page.evaluate(() => { window.__ctx.race.start(); window.__ctx.race.autoDrive = true; });
  await page.waitForFunction(() => window.__ctx.race.state === 2 && window.__ctx.race.player.forwardSpeed > 3, { timeout: 90000 });
  const racing = await page.evaluate(() => {
    const c = window.__ctx, k = c.race.player;
    c.items.give(k, 9); c.items.slot(k).arm = 0;
    const activated = c.items.use(k, false);
    return { speed: k.forwardSpeed, rocket: activated && k.rocketTime === 3, renderer: c.renderer.info.render.calls };
  });
  assert.equal(racing.rocket, true);
  await new Promise(resolve => setTimeout(resolve, 800));
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  assert.deepEqual(errors, []); assert.deepEqual(failed, []);
  console.log(JSON.stringify({ url, initial, racing, errors, failed }, null, 2));
} finally { await browser.close(); }
