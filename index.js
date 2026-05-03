const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 10000;

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
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
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    // Bloquer images, fonts, CSS — scraping chirurgical
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto('https://www.royalton-crix.com/getvcrix', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Attendre que Highcharts rende les données (max 20s)
    await page.waitForFunction(
      () => window.Highcharts?.charts?.some(c => c && c.series?.[0]?.data?.length > 0),
      { timeout: 20000 }
    ).catch(() => console.warn('[VCRIX] Highcharts not ready, trying anyway'));

    const result = await page.evaluate(() => {
      // Méthode 1 : API Highcharts directe
      if (window.Highcharts && window.Highcharts.charts) {
        for (const chart of window.Highcharts.charts) {
          if (!chart) continue;
          const series = chart.series?.[0];
          if (series?.data?.length > 0) {
            const lastPoint = series.data[series.data.length - 1];
            if (lastPoint?.y > 50) return { value: lastPoint.y, method: 'highcharts_api' };
          }
        }
      }
      // Méthode 2 : data labels DOM
      const tspans = document.querySelectorAll('.highcharts-data-labels tspan');
      const vals = [];
      tspans.forEach(el => {
        const v = parseFloat(el.textContent.replace(',', ''));
        if (v > 50 && v < 5000) vals.push(v);
      });
      if (vals.length > 0) return { value: vals[vals.length - 1], method: 'data_labels' };

      return { value: null, method: 'none' };
    });

    // Extraire mean/std depuis le HTML
    const html = await page.content();
    const avgMatch = html.match(/<b>Mean:<\/b>\s*([\d,]+\.?\d*)/);
    const stdMatch = html.match(/<b>StD:<\/b>\s*([\d,]+\.?\d*)/);
    const mean = avgMatch ? parseFloat(avgMatch[1].replace(',', '')) : MEAN_FALLBACK;
    const std = stdMatch ? parseFloat(stdMatch[1].replace(',', '')) : STD_FALLBACK;
    const value = result.value || null;
    const signal = computeSignal(value, mean, std);

    console.log(`[VCRIX] value=${value} mean=${mean} std=${std} signal=${signal} method=${result.method}`);

    const data = { success: true, value, mean, std, signal, source: 'royalton-crix.com', method: result.method, cached: false };
    cache = { data, timestamp: Date.now() };
    return data;

  } catch (err) {
    console.error('[VCRIX] Puppeteer error:', err.message);
    return { success: false, value: null, mean: MEAN_FALLBACK, std: STD_FALLBACK, signal: 'NEUTRAL', source: 'none', error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/vcrix', async (req, res) => {
  const data = await scrapeVCRIX();
  res.json(data);
});

app.listen(PORT, () => console.log(`[VCRIX API] Listening on port ${PORT}`));
