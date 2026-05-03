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

async function getPage(waitUntil = 'networkidle0') {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  await page.goto('https://www.royalton-crix.com/getvcrix', { waitUntil, timeout: 40000 });
  await new Promise(r => setTimeout(r, 3000));
  const html = await page.content();
  await browser.close();
  return html;
}

function extractValue(html) {
  // Cibler la zone après le titre "Royalton CRIX Index" pour éviter les autres séries
  const crixIdx = html.indexOf('Royalton CRIX Index');
  const searchZone = crixIdx >= 0 ? html.slice(crixIdx, crixIdx + 50000) : html;

  const points = [...searchZone.matchAll(/\[(\d{13}),([\d.]+)\]/g)];
  if (points.length > 0) {
    const val = parseFloat(points[points.length - 1][2]);
    console.log(`[VCRIX] Found ${points.length} points after title, last=${val}`);
    return val;
  }

  console.warn('[VCRIX] No points found in HTML');
  return null;
}

async function scrapeVCRIX() {
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    console.log('[VCRIX] Cache hit');
    return { ...cache.data, cached: true };
  }
  try {
    const html = await getPage('networkidle0');
    const value = extractValue(html);
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
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/vcrix', async (req, res) => {
  const data = await scrapeVCRIX();
  res.json(data);
});

app.get('/debug', async (req, res) => {
  try {
    const html = await getPage('networkidle0');
    const idx = html.indexOf('Royalton CRIX Index');
    const excerpt = idx >= 0 ? html.slice(idx, idx + 600) : html.slice(0, 3000);
    res.json({
      length: html.length,
      has_series: html.includes('series'),
      has_vcrix: html.toLowerCase().includes('vcrix'),
      crix_title_found: idx >= 0,
      crix_excerpt: excerpt,
      timestamp_count: (html.match(/\d{13}/g) || []).length
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[VCRIX API] Listening on port ${PORT}`));
