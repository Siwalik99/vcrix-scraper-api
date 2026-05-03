const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000;
const VCRIX_MEAN = 462.59;
const VCRIX_STD  = 172.69;

async function scrapeVCRIX() {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process']
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image','font','stylesheet','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://www.royalton-crix.com/getvcrix', { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('.highcharts-series', { timeout: 10000 }).catch(() => {});

    const result = await page.evaluate(() => {
      // Méthode 1 : API Highcharts
      if (window.Highcharts && window.Highcharts.charts) {
        const chart = window.Highcharts.charts.find(c => c != null);
        if (chart && chart.series && chart.series[0]) {
          const series = chart.series[0];
          const raw = series.options && series.options.data;
          if (raw && raw.length > 0) {
            const last = raw[raw.length - 1];
            return { value: Array.isArray(last) ? last[1] : (last.y || last), total_points: raw.length };
          }
          if (series.points && series.points.length > 0) {
            const lp = series.points[series.points.length - 1];
            return { value: lp.y, total_points: series.points.length };
          }
        }
      }
      // Méthode 2 : DOM #summary
      const text = (document.getElementById('summary') || document.body).innerText;
      const lastMatch = text.match(/Last[:\s]+([\d,.]+)/i);
      const meanMatch = text.match(/Mean[:\s]+([\d,.]+)/i);
      const stdMatch  = text.match(/St[dD][:\s]+([\d,.]+)/i);
      return {
        value: lastMatch ? parseFloat(lastMatch[1].replace(',','')) : null,
        mean:  meanMatch ? parseFloat(meanMatch[1].replace(',','')) : null,
        std:   stdMatch  ? parseFloat(stdMatch[1].replace(',',''))  : null,
      };
    });
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

function computeSignal(value, mean, std) {
  if (!value) return 'NEUTRAL';
  if (value > mean + std)       return 'BEARISH';
  if (value < mean - std)       return 'BULLISH';
  return 'NEUTRAL';
}

app.get('/vcrix', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return res.json({ ...cache.data, cached: true });
  }
  try {
    const scraped = await scrapeVCRIX();
    const mean  = scraped.mean  || VCRIX_MEAN;
    const std   = scraped.std   || VCRIX_STD;
    const value = scraped.value || null;
    const data  = { value: value ? parseFloat(value.toFixed(2)) : null, mean, std, signal: computeSignal(value, mean, std), total_points: scraped.total_points || null, source: 'royalton-crix.com', scraped_at: new Date().toISOString(), cached: false };
    cache = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true, error: err.message });
    res.status(200).json({ value: null, mean: VCRIX_MEAN, std: VCRIX_STD, signal: 'NEUTRAL', source: 'fallback_static', error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cache_age_min: cache.fetchedAt ? Math.round((Date.now()-cache.fetchedAt)/60000) : null, cached_value: cache.data?.value || null });
});
