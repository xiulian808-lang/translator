const { ocrTranslate } = require('./_lib.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || !body.image) return res.status(400).json({ error: '缺少 image 参数' });
    const sourceLang = body.sourceLang || 'auto';
    const targetLang = body.targetLang || 'en';
    const result = await ocrTranslate(body.image, sourceLang, targetLang);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
};
