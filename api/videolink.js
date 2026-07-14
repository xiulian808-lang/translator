export const config = { runtime: 'edge' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    }
  });
}

function passthrough(upstream, referer) {
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

function driveId(url) {
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function resolveTikTok(url) {
  const api = 'https://www.tikwm.com/api/?hd=1&url=' + encodeURIComponent(url);
  const r = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0 || !j.data) {
    throw new Error('TikTok 解析失败：' + ((j && j.msg) || ('接口返回异常 ' + r.status)));
  }
  let v = j.data.hdplay || j.data.play || j.data.wmplay;
  if (!v) throw new Error('未获取到视频地址');
  if (v.startsWith('/')) v = 'https://www.tikwm.com' + v;
  return v;
}

// 多平台解析（cobalt），用于 YouTube / Instagram / X 等。
// 想要稳定，请在 Vercel 环境变量里设置 COBALT_API（你自己的/付费的 cobalt 实例地址），
// 需要密钥时再设置 COBALT_KEY。
async function resolveCobalt(url) {
  const bases = [];
  if (typeof process !== 'undefined' && process.env && process.env.COBALT_API) {
    bases.push(process.env.COBALT_API.replace(/\/+$/, ''));
  }
  bases.push(
    'https://cobalt-api.kwiatekmiki.com',
    'https://cobalt-backend.canine.tools',
    'https://capi.oak.li'
  );
  const headers = { 'content-type': 'application/json', 'accept': 'application/json' };
  const key = (typeof process !== 'undefined' && process.env) ? process.env.COBALT_KEY : null;
  if (key) headers['authorization'] = 'Api-Key ' + key;

  let lastErr = '解析服务无响应';
  for (const base of bases) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, videoQuality: '480', filenameStyle: 'basic' }),
        signal: ctrl.signal
      });
      clearTimeout(to);
      const j = await r.json().catch(() => null);
      if (j) {
        if ((j.status === 'tunnel' || j.status === 'redirect' || j.status === 'stream') && j.url) return j.url;
        if (j.status === 'picker' && Array.isArray(j.picker) && j.picker.length) {
          const p = j.picker.find(x => x && x.url);
          if (p) return p.url;
        }
        if (j.error) lastErr = (j.error.code || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)));
        else if (j.text) lastErr = j.text;
      } else {
        lastErr = '解析服务返回异常 HTTP ' + r.status;
      }
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }
  throw new Error(lastErr);
}

async function streamFrom(videoUrl, referer) {
  const h = { 'User-Agent': 'Mozilla/5.0' };
  if (referer) h['Referer'] = referer;
  const r = await fetch(videoUrl, { headers: h });
  if (!r.ok) throw new Error('下载视频失败 HTTP ' + r.status);
  return passthrough(r);
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const url = (searchParams.get('url') || '').trim();
  if (!url) return json({ error: '缺少链接' }, 400);

  try {
    // ---------- TikTok / 抖音 ----------
    if (/tiktok\.com|douyin\.|vm\.tiktok|vt\.tiktok/i.test(url)) {
      const v = await resolveTikTok(url);
      return await streamFrom(v, 'https://www.tikwm.com/');
    }

    // ---------- Google Drive ----------
    if (/drive\.google\.com/i.test(url)) {
      const id = driveId(url);
      if (!id) return json({ error: '无法识别 Google Drive 链接' }, 422);
      let dl = 'https://drive.google.com/uc?export=download&id=' + id;
      let r = await fetch(dl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const html = await r.text();
        const m = html.match(/confirm=([0-9A-Za-z_-]+)/) || html.match(/name="confirm"\s+value="([^"]+)"/);
        const uuid = html.match(/name="uuid"\s+value="([^"]+)"/);
        if (m) {
          dl = 'https://drive.usercontent.google.com/download?id=' + id + '&export=download&confirm=' + m[1] + (uuid ? ('&uuid=' + uuid[1]) : '');
          r = await fetch(dl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        } else {
          return json({ error: '该 Drive 文件可能未公开分享（需设为"任何人可查看"）' }, 422);
        }
      }
      if (!r.ok) return json({ error: '下载失败 HTTP ' + r.status }, 502);
      return passthrough(r);
    }

    // ---------- YouTube / Instagram / X 等（多平台解析）----------
    if (/youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com|facebook\.com/i.test(url)) {
      try {
        const v = await resolveCobalt(url);
        return await streamFrom(v);
      } catch (e) {
        const plat = /instagram\.com/i.test(url) ? 'Instagram' : (/youtube\.com|youtu\.be/i.test(url) ? 'YouTube' : '该平台');
        return json({ error: plat + ' 解析失败：' + ((e && e.message) || e) + '。可先下载视频再上传，或在 Vercel 配置 COBALT_API 使用稳定的解析服务。' }, 422);
      }
    }

    return json({ error: '暂不支持该链接，目前支持 TikTok、Google Drive、YouTube、Instagram' }, 422);
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
