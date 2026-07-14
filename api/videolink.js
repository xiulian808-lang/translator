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

function passthrough(upstream) {
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const url = (searchParams.get('url') || '').trim();
  if (!url) return json({ error: '缺少链接' }, 400);

  try {
    // ---------- TikTok / 抖音 ----------
    if (/tiktok\.com|douyin\.|vm\.tiktok|vt\.tiktok/i.test(url)) {
      const v = await resolveTikTok(url);
      const r = await fetch(v, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' } });
      if (!r.ok) return json({ error: '下载视频失败 HTTP ' + r.status }, 502);
      return passthrough(r);
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

    // ---------- 暂不稳定支持 ----------
    if (/instagram\.com/i.test(url)) {
      return json({ error: 'Instagram 暂不稳定支持，建议先把视频下载下来再上传，或改用 Google Drive 链接' }, 422);
    }
    if (/youtube\.com|youtu\.be/i.test(url)) {
      return json({ error: 'YouTube 暂不支持，建议先把视频下载下来再上传' }, 422);
    }

    return json({ error: '暂不支持该链接，目前支持 TikTok 和 Google Drive' }, 422);
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
