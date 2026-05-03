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

    // Extraire la première série [timestamp, value] — c'est le VCRIX
    // On isole le bloc de la première série avant le treemap
    let value = null;
    const firstSeriesMatch = html.match(/series\s*:\s*\[\{[\s\S]*?data\s*:\s*\[([\s\S]*?)\]\s*\}/);
    if (firstSeriesMatch) {
      const points = [...firstSeriesMatch[1].matchAll(/\[(\d{13}),([\d.]+)\]/g)];
      if (points.length > 0) {
        value = parseFloat(points[points.length - 1][2]);
        console.log(`[VCRIX] Found ${points.length} points in first series, last value: ${value}`);
      }
    }

    if (!value) {
      // Fallback : chercher le dernier point de toute la page avec timestamp 13 chiffres
      const allPoints = [...html.matchAll(/\[(\d{13}),([\d.]+)\]/g)];
      // Filtrer uniquement les valeurs plausibles pour le VCRIX (100-2000)
      const vcrixPoints = allPoints.filter(m => {
        const v = parseFloat(m[2]);
        return v >= 100 && v <= 2000;
      });
      if (vcrixPoints.length > 0) {
        value = parseFloat(vcrixPoints[vcrixPoints.length - 1][2]);
        console.log(`[VCRIX] Fallback: found ${vcrixPoints.length} plausible points, last: ${value}`);
      }
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
