const express = require('express');
const puppeteer = require('puppeteer');

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
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });

    const page = await browser.newPage();

    // Intercepter les réponses réseau pour capturer les données Highcharts
    let capturedData = null;
    page.on('response', async (response) => {
      const url = response.url();
      // Chercher les appels JSON contenant des données de séries temporelles
      if (url.includes('crix') || url.includes('data') || url.includes('json') || url.includes('chart')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const json = await response.json();
            // Chercher un tableau de valeurs numériques [timestamp, value]
            const arr = Array.isArray(json) ? json : (json.data || json.series || json.values);
            if (Array.isArray(arr) && arr.length > 0) {
              const last = arr[arr.length - 1];
              const val = Array.isArray(last) ? last[1] : (last.y || last.value || last.close);
              if (val && val > 50 && val < 5000) {
                capturedData = val;
                console.log(`[VCRIX] Intercepted JSON data: value=${val} from ${url}`);
              }
            }
          }
        } catch (e) { /* ignore */ }
      }
    });

    // NE PAS bloquer CSS/JS — nécessaire pour que Highcharts charge ses données
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

    // Extraire mean/std
    const html = await page.content();
    const avgMatch = html.match(/<b>Mean:<\/b>\s*([\d,]+\.?\d*)/);
    const stdMatch = html.match(/<b>StD:<\/b>\s*([\d,]+\.?\d*)/);
    const mean = avgMatch ? parseFloat(avgMatch[1].replace(',', '')) : MEAN_FALLBACK;
    const std = stdMatch ? parseFloat(stdMatch[1].replace(',', '')) : STD_FALLBACK;

    // Tentative SVG path en dernier recours
    let value = capturedData;
    if (!value) {
      value = await page.evaluate(() => {
        // Lire les points SVG du graphique Highcharts
        const points = document.querySelectorAll('.highcharts-series path, .highcharts-point');
        const labels = document.querySelectorAll('.highcharts-yaxis-labels text, .highcharts-data-label text');
        const vals = [];
        labels.forEach(el => {
          const v = parseFloat(el.textContent.replace(/,/g, ''));
          if (v > 50 && v < 5000) vals.push(v);
        });
        return vals.length > 0 ? vals[vals.length - 1] : null;
      });
    }

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
