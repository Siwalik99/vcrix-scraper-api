const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 10000;

const CACHE_TTL_MS = 30 * 60 * 1000;
const MEAN_FALLBACK = 462.59;
const STD_FALLBACK = 172.69;
let cache = { data: null, timestamp: 0 };

function computeSignal(value, mean, std) {
  if (value === null) return 'NEUTRAL';
  if (value > mean + std) return 'BEARISH';
  if (value < mean - std) return 'BULLISH';
  return 'NEUTRAL';
}

async function scrapeVCRIX() {
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    console.log('[VCRIX] Cache hit');
    return { ...cache.data, cached: true };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto('https://www.royalton-crix.com/getvcrix', {
      waitUntil: 'networkidle0',
      timeout: 35000
    });

    const html = await page.content();

    // Les données sont inline : series: [{ data: [ [timestamp,value],... ] }]
    // On extrait TOUS les points [timestamp, valeur_numerique] et on prend le dernier
    const allPoints = [...html.matchAll(/\[1\d{12},([\d.]+)\]/g)];
    let value = null;
    if (allPoints.length > 0) {
      value = parseFloat(allPoints[allPoints.length - 1][1]);
      console.log(`[VCRIX] Found ${allPoints.length} points, last value: ${value}`);
    } else {
      console.warn('[VCRIX] No timestamp-value points found in HTML');
    }

    const avgMatch = html.match(/<b>Mean:<\/b>\s*([\d,]+\.?\d*)/);
    const stdMatch = html.match(/<b>StD:<\/b>\s*([\d,]+\.?\d*)/);
    const mean = avgMatch ? parseFloat(avgMatch[1].replace(',', '')) : MEAN_FALLBACK;
    const std = stdMatch ? parseFloat(stdMatch[1].replace(',', '')) : STD_FALLBACK;

    const signal = computeSignal(value, mean, std);
    console.log(`[VCRIX] value=${value} mean=${mean} std=${std} signal=${signal}`);

    const data = { success: true, value, mean, std, signal, source: 'royalton-crix.com', cached: false };
    cache = { data, timestamp: Date.now() };
    return data;

  } catch (err) {
    console.error('[VCRIX] Error:', err.message);
    return { success: false, value: null, mean: MEAN_FALLBACK, std: STD_FALLBACK, signal: 'NEUTRAL', source: 'none', error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/vcrix', async (req, res) => {
  const data = await scrapeVCRIX();
  res.json(data);
});

app.listen(PORT, () => console.log(`[VCRIX API] Listening on port ${PORT}`));
