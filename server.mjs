import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
async function llm({ system, messages, max = 4096 }) {
  const A = env.ANTHROPIC_API_KEY, O = env.OPENAI_API_KEY;
  if (!A && !O) throw { status: 503, msg: 'NO_KEY' };
  const body = A ? JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: messages.map(m => ({ role: m.role, content: m.content.map(p =>
      p.type === 'image' ? { type:'image', source:{ type:'base64', media_type:p.media, data:p.data } }
    : p.type === 'pdf' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:p.data } }
    : { type:'text', text:p.text }) })) })
  : JSON.stringify({ model: env.AI_MODEL || 'gpt-4o', max_tokens: max, messages: [{ role:'system', content:system }, ...messages.map(m => ({ role:m.role, content: m.content.filter(p=>p.type!=='pdf').map(p =>
      p.type === 'image' ? { type:'image_url', image_url:{ url:`data:${p.media};base64,${p.data}` } } : { type:'text', text:p.text }) }))] });
  for (let t = 0; t < 4; t++) {
    const r = A
      ? await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'x-api-key':A,'anthropic-version':'2023-06-01','content-type':'application/json'}, body })
      : await fetch((env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', { method:'POST', headers:{'Authorization':'Bearer '+O,'content-type':'application/json'}, body });
    if (r.status === 429 || r.status === 529 || r.status >= 500) { await sleep(1500 * 2 ** t); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, msg: j.error?.message || 'AI error ' + r.status };
    return A ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : j.choices[0].message.content;
  }
  throw { status: 429, msg: 'RATE' };
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
      const { system = '', messages = [], web = false, max } = JSON.parse(await readBody(req));
      let sys = system;
      if (web) {
        const last = [...messages].reverse().find(m => m.role === 'user')?.content.find(p => p.type === 'text')?.text || '';
        const hits = last ? await search(last) : [];
        if (hits.length) sys += '\n\nBackground from a live web lookup (use naturally if relevant; never mention it, never tell the user to search):\n' + hits.map(h => `- ${h.title}: ${h.snippet}`).join('\n');
      }
      sys += '\n\nToday is ' + new Date().toDateString() + '.';
      return json(res, 200, { text: await llm({ system: sys, messages, max }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/image') {
      const p = (url.searchParams.get('prompt') || '').slice(0, 800); if (!p) return json(res, 400, { error: 'No prompt' });
      for (let t = 0; t < 3; t++) {
        const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&nologo=true&seed=${+url.searchParams.get('seed') || 1}`, { signal: AbortSignal.timeout(70000) }).catch(() => null);
        if (r?.ok) { res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' }); return res.end(Buffer.from(await r.arrayBuffer())); }
        await sleep(1500 * (t + 1));
      }
      return json(res, 502, { error: 'Image service busy' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const file = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (file.includes('..') || /server\.mjs|package\.json|\.env|start\.bat/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(join(root, file));
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.msg });
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    json(res, 500, { error: 'Server error' });
  }
});
const port = +env.PORT || 3000, host = env.HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => console.log(`StudyHub running at http://${host}:${port}  (AI key: ${env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY ? 'found' : 'MISSING - see README'})`));
