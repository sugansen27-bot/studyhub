import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

/* settings file: config.env next to this file (KEY=value per line) */
for (const name of ['config.env', '.env']) {
  try { for (const l of readFileSync(name, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
}

const root = process.cwd(), env = process.env;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (res, code, obj) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); };

/* ---------- web search (no key) ---------- */
function decodeEntities(v='') { return v.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)); }
const stripTags = v => decodeEntities(v.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')).trim();
function extractResults(html) {
  const out = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if (!link) continue;
    let url = decodeEntities(link[1]); const rd = url.match(/[?&]uddg=([^&]+)/); if (rd) { try { url = decodeURIComponent(rd[1]); } catch {} }
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    out.push({ title: stripTags(link[2]), snippet: sn ? stripTags(sn[1]) : '', url });
    if (out.length >= 6) break;
  }
  return out;
}
async function search(q) {
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q.slice(0, 240)), { headers: {'User-Agent':'Mozilla/5.0 (compatible; StudyHub/2.0)'}, signal: AbortSignal.timeout(8000) });
    return r.ok ? extractResults(await r.text()) : [];
  } catch { return []; }
}

/* ---------- AI (Anthropic or any OpenAI-compatible API). Retries on rate limits. ---------- */
const clean = t => String(t).replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
async function llm({ system, messages, max = 4096, tier = 'smart', temp, onText }) {
  const A = env.ANTHROPIC_API_KEY, O = env.OPENAI_API_KEY;
  if (!A && !O) throw { status: 503, msg: 'NO_KEY' };
  const hasImg = messages.some(m => m.content.some(p => p.type === 'image'));
  const model = hasImg ? (env.AI_MODEL_VISION || env.AI_MODEL) : tier === 'fast' ? (env.AI_MODEL_FAST || env.AI_MODEL) : (env.AI_MODEL_SMART || env.AI_MODEL);
  const extra = { ...(temp == null ? {} : { temperature: temp }), ...(onText ? { stream: true } : {}) };
  const build = m => A ? JSON.stringify({ model: m || 'claude-sonnet-5-5', max_tokens: max, system, ...extra, messages: messages.map(m => ({ role: m.role, content: m.content.map(p =>
      p.type === 'image' ? { type:'image', source:{ type:'base64', media_type:p.media, data:p.data } }
    : p.type === 'pdf' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:p.data } }
    : { type:'text', text:p.text }) })) })
  : JSON.stringify({ model: m || 'gpt-4o', max_tokens: max, ...extra, messages: [{ role:'system', content:system }, ...messages.map(m => ({ role:m.role, content: m.content.filter(p=>p.type!=='pdf').map(p =>
      p.type === 'image' ? { type:'image_url', image_url:{ url:`data:${p.media};base64,${p.data}` } } : { type:'text', text:p.text }) }))] });
  let body = build(model), fb = false;
  for (let t = 0; t < 4; t++) {
    const r = A
      ? await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'x-api-key':A,'anthropic-version':'2023-06-01','content-type':'application/json'}, body })
      : await fetch((env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', { method:'POST', headers:{'Authorization':'Bearer '+O,'content-type':'application/json'}, body });
    if (r.status === 429 || r.status === 529 || r.status >= 500) { await sleep(1500 * 2 ** t); continue; }
    if (!r.ok) {
      if ([400, 404].includes(r.status) && env.AI_MODEL && model !== env.AI_MODEL && !fb) { fb = true; body = build(env.AI_MODEL); t--; continue; }
      const j = await r.json().catch(() => ({})); throw { status: r.status, msg: j.error?.message || 'AI error ' + r.status };
    }
    if (onText) {
      let buf = '', all = ''; const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (d === '[DONE]') continue;
          try { const j = JSON.parse(d); const x = A ? (j.type === 'content_block_delta' ? j.delta?.text : '') : j.choices?.[0]?.delta?.content; if (x) { all += x; onText(x); } } catch {}
        }
      }
      return clean(all);
    }
    const j = await r.json().catch(() => ({}));
    return clean(A ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : j.choices[0].message.content);
  }
  throw { status: 429, msg: 'RATE' };
}

/* ---------- images: FLUX via Pollinations. One at a time, retries, optional free key for higher limits ---------- */
const STYLES = { auto: '', photo: 'ultra-realistic photograph, natural lighting, sharp focus, 50mm lens', illustration: 'polished digital illustration, clean lines, vibrant colors', anime: 'anime style, detailed, vibrant, studio quality', paint: 'oil painting, rich brushwork, painterly texture', render: '3D render, soft studio lighting, high detail', logo: 'clean vector logo design, flat simple shapes, centered, plain background' };
const SHAPES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] };
let imgChain = Promise.resolve();
const queueImage = (...a) => { const job = imgChain.then(() => makeImage(...a)); imgChain = job.catch(() => {}); return job; };
async function makeImage(p, w, h, seed) {
  const key = env.POLLINATIONS_KEY ? `&key=${encodeURIComponent(env.POLLINATIONS_KEY)}` : '';
  const q = `?model=${env.IMAGE_MODEL || 'flux'}&width=${w}&height=${h}&seed=${seed}&nologo=true${key}`;
  const bases = env.IMAGE_BASE ? [env.IMAGE_BASE] : ['https://gen.pollinations.ai/image/', 'https://image.pollinations.ai/prompt/'];
  for (let t = 0; t < 3; t++) {
    for (const b of bases) {
      const r = await fetch(b + encodeURIComponent(p) + q, { signal: AbortSignal.timeout(35000) }).catch(() => null);
      if (r?.ok && (r.headers.get('content-type') || '').startsWith('image/')) return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
    }
    await sleep(4000 * (t + 1));
  }
  throw { status: 502, msg: 'Image service busy' };
}

/* ---------- video: animate drawings, objects, pets and scenes, or make a clip from a description. Real people are blocked. ---------- */
const jobs = new Map(), tmpImgs = new Map(); let vidChain = Promise.resolve();
setInterval(() => { const n = Date.now(); for (const [k, v] of jobs) if (v.exp < n) jobs.delete(k); for (const [k, v] of tmpImgs) if (v.exp < n) tmpImgs.delete(k); }, 60000).unref();
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const PROMPT_RULES = 'You are a safety filter. Reply with ONLY JSON: {"block":true|false,"reason":"short"}. Set block to true if the request asks for a video of a real, identifiable person (a named public figure or celebrity, or anyone the user knows such as "me", "my teacher", "my classmate", "my friend", "my mom", or a person in an uploaded photo), or asks for sexual, graphic violent or hateful content. Fictional or generic characters (a cartoon robot, a knight, an anime character, a dragon, a generic silhouette) are fine.';
const PHOTO_RULES = 'You are a safety filter. Reply with ONLY JSON: {"human":true|false}. Set human to true if the image contains a photograph of a real human, or a photorealistic human face or body (selfie, portrait, group photo, or a clearly visible person in a photo), OR if you are unsure. Set human to false for cartoons, drawings, anime, 3D or game characters, paintings of fictional characters, animals, objects, buildings, landscapes, food, and diagrams.';
async function judge(system, text, imgB64) {
  const content = [...(imgB64 ? [{ type: 'image', media: 'image/jpeg', data: imgB64 }] : []), { type: 'text', text }];
  try { const t = await llm({ system, messages: [{ role: 'user', content }], tier: 'fast', temp: 0, max: 80 }); return JSON.parse(t.match(/\{[\s\S]*\}/)[0]); } catch { return null; }
}
async function runVideo(job, p, dur, ar, imgUrl) {
  let final = p;
  try { final = clean(await llm({ tier: 'fast', temp: 0.7, max: 200, messages: [{ role: 'user', content: [{ type: 'text', text: p }] }],
    system: "You write prompts for an AI video generator. Rewrite the idea as ONE prompt of 30-60 words: subject, the specific motion, camera movement, lighting and style. " + (imgUrl ? 'The video animates a provided image, so describe only the motion and camera, not a new scene. ' : '') + "Keep all of the user's details. Output only the prompt." })) || p; } catch {}
  const key = env.POLLINATIONS_KEY ? `&key=${encodeURIComponent(env.POLLINATIONS_KEY)}` : '';
  const q = `?model=${env.VIDEO_MODEL || 'seedance'}&duration=${dur}&aspectRatio=${ar}${imgUrl ? '&image=' + encodeURIComponent(imgUrl) : ''}${key}`;
  const r = await fetch((env.VIDEO_BASE || 'https://gen.pollinations.ai/image/') + encodeURIComponent(final) + q, { signal: AbortSignal.timeout(240000) }).catch(() => null);
  const fail = m => { job.state = 'error'; job.msg = m; };
  if (!r) return fail('The video service did not answer. Try again in a minute.');
  if ([401, 402, 403].includes(r.status)) return fail('Video needs a Pollinations key with credits. Ask the site owner to set POLLINATIONS_KEY.');
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.startsWith('video/')) return fail('The video service is busy or could not make that clip. Try again.');
  job.buf = Buffer.from(await r.arrayBuffer()); job.type = ct; job.state = 'done'; job.exp = Date.now() + 30 * 60000;
}

async function readBody(req, limit = 40e6) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw { status: 413, msg: 'Upload too large' }; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/ai') {
      const { system = '', messages = [], web = false, max, tier, temp, stream } = JSON.parse(await readBody(req));
      let sys = system;
      if (web) {
        const last = [...messages].reverse().find(m => m.role === 'user')?.content.find(p => p.type === 'text')?.text || '';
        const hits = last ? await search(last) : [];
        if (hits.length) sys += '\n\nBackground from a live web lookup (use naturally if relevant; never mention it, never tell the user to search):\n' + hits.map(h => `- ${h.title}: ${h.snippet}`).join('\n');
      }
      sys += '\n\nToday is ' + new Date().toDateString() + '.';
      if (stream) {
        let started = false; const head = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
        try { await llm({ system: sys, messages, max, tier, temp, onText: t => { if (!started) { started = true; res.writeHead(200, head); } res.write(t); } }); }
        catch (e) { if (!started) throw e; }
        if (!started) res.writeHead(200, head);
        return res.end();
      }
      return json(res, 200, { text: await llm({ system: sys, messages, max, tier, temp }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      /* speech to text with automatic language detection (Whisper-compatible API) */
      const key = env.STT_KEY || env.OPENAI_API_KEY; if (!key) throw { status: 503, msg: 'NO_STT' };
      const { audio = '', mime = 'audio/webm' } = JSON.parse(await readBody(req, 12e6));
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
      const fd = new FormData(); fd.append('file', new Blob([Buffer.from(audio, 'base64')], { type: mime }), 'speech.' + ext);
      fd.append('model', env.STT_MODEL || 'whisper-1'); fd.append('response_format', 'verbose_json'); fd.append('temperature', '0');
      const r = await fetch((env.STT_BASE || env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(30000) }).catch(() => null);
      if (!r) throw { status: 502, msg: 'The speech service did not answer. Try again.' };
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw { status: r.status === 429 ? 429 : 502, msg: j.error?.message || 'Speech service error ' + r.status };
      const segs = j.segments || [];
      const silent = segs.length && segs.every(x => (x.no_speech_prob ?? 0) > 0.6);
      return json(res, 200, { text: silent ? '' : (j.text || '').trim(), language: j.language || '' });
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/video') {
      const { prompt = '', duration = 6, aspect = '16:9', image = null } = JSON.parse(await readBody(req));
      const p = String(prompt).slice(0, 500).trim(); if (!p) return json(res, 400, { error: 'Describe the video you want.' });
      const host = req.headers.host || '', proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
      if (image && /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(host) && !env.PUBLIC_URL) return json(res, 400, { error: 'Animating an image only works on the deployed website, because the video service has to reach it. Text-only videos work everywhere.' });
      const m = await judge(PROMPT_RULES, p);
      if (!m || m.block) return json(res, 400, { error: m ? "I can't make videos of real people or that kind of content. Try a fictional character, an animal, an object or a scene." : "I couldn't check that request just now. Try again in a moment." });
      let imgUrl = null;
      if (image) {
        const h = await judge(PHOTO_RULES, 'Check this image.', image);
        if (!h || h.human !== false) return json(res, 400, { error: h ? "That image seems to show a real person, so I can't animate it. Use a drawing, an object, a pet or a scene instead." : "I couldn't check that image just now, so I didn't use it. Try again in a moment." });
        const iid = rid(); tmpImgs.set(iid, { buf: Buffer.from(image, 'base64'), exp: Date.now() + 15 * 60000 });
        imgUrl = `${env.PUBLIC_URL || proto + '://' + host}/api/tmpimg?id=${iid}`;
      }
      const id = rid(), job = { state: 'working', exp: Date.now() + 30 * 60000 }; jobs.set(id, job);
      while (jobs.size > 10) jobs.delete(jobs.keys().next().value);
      const dur = [4, 6, 8].includes(+duration) ? +duration : 6, ar = aspect === '9:16' ? '9:16' : '16:9';
      vidChain = vidChain.then(() => runVideo(job, p, dur, ar, imgUrl)).catch(() => { job.state = 'error'; job.msg = 'Something went wrong making the video.'; });
      return json(res, 200, { id });
    }
    if (req.method === 'GET' && url.pathname === '/api/video-status') {
      const j = jobs.get(url.searchParams.get('id')); return json(res, 200, j ? { state: j.state, msg: j.msg } : { state: 'gone' });
    }
    if (req.method === 'GET' && url.pathname === '/api/tmpimg') {
      const t = tmpImgs.get(url.searchParams.get('id')); if (!t) { res.writeHead(404); return res.end('Gone'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(t.buf);
    }
    if (req.method === 'GET' && url.pathname === '/api/video-file') {
      const j = jobs.get(url.searchParams.get('id')); if (!j || j.state !== 'done') { res.writeHead(404); return res.end('Gone'); }
      const total = j.buf.length, rg = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
      if (rg) { const a = rg[1] ? +rg[1] : 0, b = Math.min(rg[2] ? +rg[2] : total - 1, total - 1);
        res.writeHead(206, { 'Content-Type': j.type, 'Content-Range': `bytes ${a}-${b}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 }); return res.end(j.buf.subarray(a, b + 1)); }
      res.writeHead(200, { 'Content-Type': j.type, 'Content-Length': total, 'Accept-Ranges': 'bytes' }); return res.end(j.buf);
    }
    if (req.method === 'POST' && url.pathname === '/api/image-plan') {
      const { prompt = '', style = 'auto', shape = 'square' } = JSON.parse(await readBody(req));
      const [w, h] = SHAPES[shape] || SHAPES.square; let final = String(prompt).slice(0, 600);
      try {
        final = clean(await llm({ tier: 'fast', temp: 0.7, max: 250,
          system: "You write prompts for an AI image generator. Rewrite the user's idea as ONE vivid, specific prompt of 40-70 words: subject, setting, composition, camera angle, lighting, color palette, mood and visual style. Keep every detail the user asked for and add nothing that contradicts it. Do not ask for text or words in the image unless the user wants them. Output only the prompt.",
          messages: [{ role: 'user', content: [{ type: 'text', text: `Idea: ${final}\nStyle: ${STYLES[style] || 'pick the best style for this idea'}` }] }] })) || final;
      } catch { final = [final, STYLES[style]].filter(Boolean).join(', '); }
      return json(res, 200, { prompt: final, w, h });
    }
    if (req.method === 'GET' && url.pathname === '/api/image') {
      const p = (url.searchParams.get('prompt') || '').slice(0, 900); if (!p) return json(res, 400, { error: 'No prompt' });
      const w = Math.min(2048, +url.searchParams.get('w') || 1024), h = Math.min(2048, +url.searchParams.get('h') || 1024);
      const out = await queueImage(p, w, h, +url.searchParams.get('seed') || 1);
      res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'public, max-age=31536000' });
      return res.end(out.buf);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const file = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (file.includes('..') || /server\.mjs|package\.json|\.env|start\.bat/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(join(root, file));
    const hd = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }; let body = data;
    if (/gzip/.test(req.headers['accept-encoding'] || '') && /\.(html|js|css|json|svg)$/.test(file)) { body = gzipSync(data); hd['Content-Encoding'] = 'gzip'; hd['Vary'] = 'Accept-Encoding'; }
    res.writeHead(200, hd);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.msg });
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    json(res, 500, { error: 'Server error' });
  }
});
const port = +env.PORT || 3000, host = env.HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => console.log(`StudyHub running at http://${host}:${port}  (AI key: ${env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY ? 'found' : 'MISSING - see README'}, speech key: ${env.STT_KEY || env.OPENAI_API_KEY ? 'found' : 'none - live speech translation needs OPENAI_API_KEY'})`));
