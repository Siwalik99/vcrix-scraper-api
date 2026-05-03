const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/vcrix', async (req, res) => {
  try {
    const response = await fetch('https://www.royalton-crix.com/getvcrix', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      }
    });
    const html = await response.text();
    
    // Extraire mean et std
    const avgMatch = html.match(/<b>Mean:<\/b>\s*([\d,]+\.?\d*)/);
    const stdMatch = html.match(/<b>StD:<\/b>\s*([\d,]+\.?\d*)/);
    const mean = avgMatch ? parseFloat(avgMatch[1].replace(',', '')) : 462.59;
    const std = stdMatch ? parseFloat(stdMatch[1].replace(',', '')) : 172.69;

    res.json({ success: true, mean, std, value: null, signal: 'NEUTRAL', source: 'royalton-crix.com' });
  } catch (err) {
    res.json({ success: false, error: err.message, mean: 462.59, std: 172.69, value: null, signal: 'NEUTRAL' });
  }
});

app.listen(PORT, () => console.log(`VCRIX API listening on port ${PORT}`));
