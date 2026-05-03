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

async function getPage() {
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
  await page.goto('https://www.royalton-crix.com/getvcrix', { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 3000));
  const html = await page.content();
  await browser.close();
  return html;
}

function extractValue(html) {
  const treemapIdx = html.indexOf("type: 'treemap'");
  const searchZone = treemapIdx > 0 ? html.slice(0, treemapIdx) : html;

  const points = [...searchZone.matchAll(/\[(\d{13}),([\d.]+)\]/g)];
  if (points.length > 0) {
    const val = parseFloat(points[points.length - 1][2]);
    console.log(`[VCRIX] Found ${points.length} points (before treemap), last=${val}`);
    return val;
  }

  console.warn('[VCRIX] No points found');
  return null;
}

async function scrapeVCRIX() {
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    console.log('[VCRIX] Cache hit');
    return { ...cache.data, cached: true };
  }
  try {
    const html = await getPage();
    const value = extractValue(html);
    const avgMatch = html.match(/<b>Mean:<\/b>\s*([\d,]+\.?\d*)/);
    const stdMatch = html.match(/<b>StD:<\/b>\s*([\d,]+\.?\d*)/);
    const mean = avgMatch ? parseFloat(avgMatch[1].replace(',', '')) : MEAN_FALLBACK;
    const std = stdMatch ? parseFloat(stdMatch[1].replace(',', '')) : STD_FALLBACK;
    const signal = computeSignal(value, mean, std);
    console.log(`[VCRIX] value=${value} mean=${mean} std=${std} signal=${signal}`);
    const data = { success: true, value, mean, std, signal, source: 'royalton-crix.com', cached: false };
    // ✅ FIX: ne pas cacher si value=null (scrape raté)
    if (value !== null) {
      cache = { data, timestamp: Date.now() };
    }
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
    const html = await getPage();
    const treemapIdx = html.indexOf("type: 'treemap'");
    const searchZone = treemapIdx > 0 ? html.slice(0, treemapIdx) : html;
    const points = [...searchZone.matchAll(/\[(\d{13}),([\d.]+)\]/g)];
    const lastPoints = points.slice(-5).map(m => ({ ts: m[1], val: m[2] }));
    res.json({
      html_length: html.length,
      treemap_found: treemapIdx > 0,
      treemap_position: treemapIdx,
      points_before_treemap: points.length,
      last_5_points: lastPoints,
      extracted_value: points.length > 0 ? parseFloat(points[points.length - 1][2]) : null
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[VCRIX API] Listening on port ${PORT}`));
