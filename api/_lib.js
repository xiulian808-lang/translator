// Shared translation logic. Files prefixed with "_" are NOT turned into routes by Vercel.

const LANG_NAMES = {
  auto: 'the auto-detected source language',
  zh: 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  ru: 'Russian (Русский)',
  pt: 'Portuguese (Português)',
  it: 'Italian (Italiano)',
  ar: 'Arabic (العربية)',
  th: 'Thai (ไทย)',
  vi: 'Vietnamese (Tiếng Việt)',
  id: 'Indonesian (Bahasa Indonesia)',
  hi: 'Hindi (हिन्दी)',
  tr: 'Turkish (Türkçe)',
  nl: 'Dutch (Nederlands)',
  pl: 'Polish (Polski)'
};

function langName(code) {
  return LANG_NAMES[code] || code || 'English';
}

// DeepL uses its own language codes.
const DEEPL_TARGET = {
  zh: 'ZH', 'zh-TW': 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR',
  de: 'DE', ru: 'RU', pt: 'PT-PT', it: 'IT', ar: 'AR', tr: 'TR', nl: 'NL',
  pl: 'PL', id: 'ID', th: 'TH', vi: 'VI', hi: 'HI'
};
const DEEPL_SOURCE = { ...DEEPL_TARGET, 'zh-TW': 'ZH' };

function getProvider() {
  return (process.env.PROVIDER || 'openai').toLowerCase();
}

// --- OpenAI-compatible (OpenAI / DeepSeek / 通义 / 智谱 / Kimi / 本地大模型) ---
function openaiConfig() {
  return {
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    visionModel: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini'
  };
}

function extractJson(text) {
  // Try direct parse, then pull the first {...} block out of the string.
  try { return JSON.parse(text); } catch (e) {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isRateLimit(status, text) {
  return status === 429 || /\b1302\b|rate.?limit|速率限制|并发|请求频率|频繁/i.test(text || '');
}

async function postChat(cfg, body) {
  return fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body)
  });
}

async function callOpenAIChat(messages, { json = false } = {}) {
  const cfg = openaiConfig();
  if (!cfg.key) throw new Error('服务器未配置 OPENAI_API_KEY。请在部署平台的环境变量里设置。');
  const body = { model: cfg.model, messages, temperature: 0.2 };
  if (json) body.response_format = { type: 'json_object' };

  const MAX = 6;
  let lastErr = '';
  for (let attempt = 0; attempt < MAX; attempt++) {
    let resp;
    try {
      resp = await postChat(cfg, body);
    } catch (e) {
      lastErr = '无法连接翻译服务：' + e.message;
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (resp.ok) {
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }
    const t = await resp.text();
    // Some providers reject response_format — drop it and retry right away.
    if (json && body.response_format && /response_format|json/i.test(t)) {
      delete body.response_format;
      continue;
    }
    // Rate limit / concurrency cap (HTTP 429 or Zhipu code 1302) — wait and retry.
    if (isRateLimit(resp.status, t)) {
      lastErr = '翻译服务限速（' + resp.status + '）：' + t.slice(0, 160);
      await sleep(800 * (attempt + 1));
      continue;
    }
    throw new Error('翻译服务返回错误 ' + resp.status + '：' + t.slice(0, 300));
  }
  throw new Error(lastErr || '翻译服务繁忙，多次重试仍失败，请稍后再试。');
}

async function translateBatchOpenAI(texts, sourceLang, targetLang) {
  const sys =
    'You are a professional translator. Translate every string in the input JSON array "src" into ' +
    langName(targetLang) + '. ' +
    (sourceLang && sourceLang !== 'auto'
      ? 'The source language is ' + langName(sourceLang) + '. '
      : 'Detect the source language automatically. ') +
    'Rules: (1) Return exactly the same number of items, in the same order. ' +
    '(2) Preserve line breaks, numbers, product names, URLs, and any inline markup. ' +
    '(3) Translate natural, fluent, marketing-quality text — not word-for-word. ' +
    '(4) If an item is empty or only symbols/numbers, return it unchanged. ' +
    '(5) Output ONLY a JSON object: {"dst": ["...", "..."]}.';
  const user = JSON.stringify({ src: texts });
  const content = await callOpenAIChat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { json: true }
  );
  const parsed = extractJson(content);
  let out = parsed && Array.isArray(parsed.dst) ? parsed.dst : null;
  if (!out || out.length !== texts.length) {
    out = new Array(texts.length);
    let fnext = 0;
    async function fworker() {
      while (fnext < texts.length) {
        const i = fnext++;
        const t = texts[i];
        if (!t || !t.trim()) { out[i] = t; continue; }
        const c = await callOpenAIChat([
          { role: 'system', content: 'Translate the user text into ' + langName(targetLang) + '. Output only the translation, no quotes, no notes.' },
          { role: 'user', content: t }
        ]);
        out[i] = c.trim();
      }
    }
    const fworkers = [];
    const fn = Math.min(2, texts.length);
    for (let w = 0; w < fn; w++) fworkers.push(fworker());
    await Promise.all(fworkers);
  }
  return out;
}

// --- DeepL (text only) ---
async function translateBatchDeepL(texts, sourceLang, targetLang) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error('服务器未配置 DEEPL_API_KEY。');
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const params = new URLSearchParams();
  texts.forEach((t) => params.append('text', t || ' '));
  params.append('target_lang', DEEPL_TARGET[targetLang] || 'EN-US');
  if (sourceLang && sourceLang !== 'auto' && DEEPL_SOURCE[sourceLang]) {
    params.append('source_lang', DEEPL_SOURCE[sourceLang]);
  }
  const resp = await fetch(base + '/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('DeepL 返回错误 ' + resp.status + '：' + t.slice(0, 300));
  }
  const data = await resp.json();
  return (data.translations || []).map((x) => x.text);
}

// Split an array of texts into char-budget-limited chunks, translate each, merge.
async function translate(texts, sourceLang, targetLang) {
  const provider = getProvider();
  const doBatch = provider === 'deepl' ? translateBatchDeepL : translateBatchOpenAI;

  const CHUNK_CHARS = 1200;
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const t of texts) {
    const len = (t || '').length + 1;
    if (cur.length && curLen + len > CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(t);
    curLen += len;
    if (len > CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
  }
  if (cur.length) chunks.push(cur);

  // Translate chunks in parallel (bounded concurrency) so large docs stay fast.
  const CONCURRENCY = 2;
  const results = new Array(chunks.length);
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await doBatch(chunks[i], sourceLang, targetLang);
    }
  }
  const workers = [];
  const n = Math.min(CONCURRENCY, chunks.length);
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results.flat();
}

// --- Vision OCR + translate (OpenAI-compatible vision models only) ---
async function ocrTranslate(imageDataUrl, sourceLang, targetLang) {
  const cfg = openaiConfig();
  if (!cfg.key) throw new Error('服务器未配置 OPENAI_API_KEY（图片识别需要视觉模型）。');
  const sys =
    'You are an OCR + translation engine. Read ALL text in the image, preserving reading order and line breaks. ' +
    'Then translate it into ' + langName(targetLang) + '. ' +
    'Output ONLY a JSON object: {"original": "<all recognized text>", "translation": "<the translation>"}. ' +
    'If there is no text, return {"original": "", "translation": ""}.';
  const body = {
    model: cfg.visionModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Recognize and translate the text in this image into ' + langName(targetLang) + '.' },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  };
  let resp = await fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    delete body.response_format;
    resp = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error('图片识别服务返回错误 ' + resp.status + '：' + t.slice(0, 300));
    }
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content) || { original: content, translation: '' };
  return { original: parsed.original || '', translation: parsed.translation || '' };
}

module.exports = { translate, ocrTranslate, getProvider, langName };
