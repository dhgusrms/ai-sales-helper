// AI 온라인 판매 도우미 - Cloudflare Worker (무료 AI 연결 통로)
//
// 하는 일: 웹사이트가 보낸 분석 요청을 Cloudflare Workers AI 모델에 전달하고, JSON 결과를 돌려준다.
// API 키가 필요 없다. Cloudflare 대시보드에서 이 Worker에 'AI' 바인딩(변수 이름 AI)만 연결하면 된다.
//
// 모델: @cf/google/gemma-4-26b-a4b-it (2026-11-12 Cloudflare 공식 모델 목록에서 확인, 지원 종료 예정 없음)
// 무료 한도: 하루 10,000 뉴런 (매일 오전 9시(한국 시간) 초기화). 상품 분석 1회 약 50뉴런(2026-11-13 실측) → 하루 약 200회.
// 한도를 넘으면 무료 플랜에서는 요금 없이 요청만 실패한다.
//
// GET /kc?no=인증번호 : 제품안전정보센터(safetykorea.kr)의 공개 인증정보 조회 화면을 대신 열어
// 그 번호가 실제로 있는지와 제품명·모델명·제조사·인증상태를 돌려준다. (인증키 필요 없음, 사용자가 누를 때만 1번 조회)

const MODEL = '@cf/google/gemma-4-26b-a4b-it';

// 이 주소에서 연 웹사이트만 Worker를 쓸 수 있다. (끝에 / 없이)
const ALLOWED_ORIGINS = [
  'https://ai-sales-helper.pages.dev',
];
// Cloudflare Pages의 미리보기 주소(예: https://abc123.ai-sales-helper.pages.dev)도 허용한다.
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.ai-sales-helper\.pages\.dev$/;
// 내 컴퓨터에서 테스트할 때(localhost)도 허용한다.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MAX_INPUT_CHARS = 40000;   // 요청 하나에 받을 최대 글자 수 (남용 방지)
const MAX_OUTPUT_TOKENS = 6000;  // 답변 최대 길이
const MAX_IMAGES = 3;              // 함께 받을 상품 사진 수
const MAX_IMAGE_CHARS = 400000;    // 사진 한 장(data URL) 최대 글자 수 (약 300KB)
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// 2026-11-13 실측: 'schema'는 Gemma 4가 공백을 끝없이 써서 6,000토큰에서 잘림(약 160초).
// 'object'는 같은 분석을 약 23초, 약 50뉴런으로 정상 완료해 기본값으로 쓴다.
const FORMAT = 'object';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin) || LOCAL_ORIGIN.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin',
    };
    const reply = (status, data) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/kc') {
      if (!allowed) return reply(403, { error: 'origin', message: '허용되지 않은 사이트에서 보낸 요청입니다.' });
      return kcLookup(new URL(request.url).searchParams.get('no'), reply, ctx);
    }
    if (request.method === 'GET') return reply(200, { ok: true, model: MODEL, message: 'AI 판매 도우미 Worker가 동작 중입니다.' });
    if (!allowed) return reply(403, { error: 'origin', message: '허용되지 않은 사이트에서 보낸 요청입니다.' });
    if (request.method !== 'POST') return reply(405, { error: 'method', message: 'POST 요청만 받습니다.' });
    if (!env.AI) return reply(500, { error: 'binding', message: 'Worker에 AI 바인딩(변수 이름 AI)이 연결되지 않았습니다.' });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: 'bad-request', message: '요청 형식이 올바르지 않습니다.' }); }
    const { system, text, schema } = body || {};
    // 상품 사진(선택): data URL 문자열 배열. 형식이 맞는 것만 최대 3장 쓴다.
    const images = (Array.isArray(body?.images) ? body.images : [])
      .filter(u => typeof u === 'string' && u.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(u))
      .slice(0, MAX_IMAGES);
    // 응답 형식 강제 방식: 'schema'(JSON 스키마), 'object'(JSON만), 'none'(지시문만). 기본은 FORMAT.
    const format = ['schema', 'object', 'none'].includes(body?.format) ? body.format : FORMAT;
    if (typeof system !== 'string' || typeof text !== 'string' || !schema || typeof schema !== 'object') {
      return reply(400, { error: 'bad-request', message: '요청 형식이 올바르지 않습니다.' });
    }
    if (system.length + text.length > MAX_INPUT_CHARS) {
      return reply(413, { error: 'size', message: '입력 내용이 너무 깁니다. 제품 설명이나 리뷰, 업로드 자료를 줄여 주세요.' });
    }

    const messages = [
      { role: 'system', content: `${system}\n\n반드시 주어진 JSON 형식으로만, 모든 내용을 한국어로 답하세요. JSON 외의 글은 쓰지 마세요.` },
      { role: 'user', content: userContent(text, images) },
    ];
    // Gemma 4는 기본으로 '생각(추론)'을 먼저 길게 해서 느리고 답이 잘린다. 꺼서 바로 답하게 한다.
    const base = {
      messages, max_completion_tokens: MAX_OUTPUT_TOKENS, temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    };

    const rf = format === 'schema' ? { type: 'json_schema', json_schema: { name: 'result', schema } }
      : format === 'object' ? { type: 'json_object' } : null;
    // 스키마로 강제하지 않을 때는 지시문에 스키마를 적어 준다.
    const withSchema = { ...base, messages: [{ ...messages[0], content: `${messages[0].content}\n\n답변 JSON 스키마:\n${JSON.stringify(schema)}` }, messages[1]] };

    let out;
    let imagesUsed = images.length > 0;
    // 사진 없이 다시 보낼 때 쓰는 요청 (사진을 모델이 받지 못했을 때)
    const textOnly = req => ({ ...req, messages: req.messages.map(m => (m.role === 'user' ? { ...m, content: text } : m)) });
    const run = async req => {
      try { return await env.AI.run(MODEL, req); } catch (e) {
        if (isLimit(e) || !imagesUsed) throw e;
        console.log(JSON.stringify({ imageFail: String(e?.message || e).slice(0, 300) }));
        imagesUsed = false;
        return env.AI.run(MODEL, textOnly(req));
      }
    };
    try {
      try {
        out = await run(rf ? { ...(format === 'schema' ? base : withSchema), response_format: rf } : withSchema);
      } catch (e) {
        if (isLimit(e) || !rf) throw e;
        // JSON 모드를 맞추지 못하면 형식 지정 없이 한 번 더 요청하고 직접 JSON을 꺼낸다.
        out = await run(imagesUsed ? withSchema : textOnly(withSchema));
      }
    } catch (e) {
      if (isLimit(e)) return reply(429, { error: 'daily-limit', message: '오늘 무료 AI 사용량을 모두 썼습니다. 한국 시간 오전 9시 이후에 다시 시도해 주세요.' });
      return reply(502, { error: 'ai', message: `AI 모델 요청이 실패했습니다. 잠시 후 다시 시도해 주세요. (${String(e?.message || e).slice(0, 200)})` });
    }

    const result = extractJSON(out);
    if (!result) {
      const cut = out?.choices?.[0]?.finish_reason === 'length';
      const raw = String(out?.choices?.[0]?.message?.content ?? out?.response ?? '');
      console.log(JSON.stringify({ fail: cut ? 'truncated' : 'parse', usage: out?.usage, head: raw.slice(0, 300), tail: raw.slice(-300) }));
      return reply(502, { error: cut ? 'truncated' : 'parse', usage: out?.usage, tail: raw.slice(-200), message: cut ? 'AI 답변이 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요.' : 'AI 응답을 읽지 못했습니다. 다시 시도해 주세요.' });
    }
    return reply(200, { result, model: MODEL, usage: out?.usage, imagesUsed });
  },
};

// ---------- KC 인증번호 조회 ----------
// 제품안전정보센터의 공개 조회 화면(인증번호를 정확히 맞춰야 나온다)을 읽는다. 같은 번호는 6시간 동안 다시 조회하지 않는다.
const KC_NO_RE = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
const KC_NOT_FOUND = '인증정보가 존재하지 않습니다';
async function kcLookup(raw, reply, ctx) {
  const no = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!KC_NO_RE.test(no)) return reply(400, { error: 'bad-request', message: '인증번호 형식이 올바르지 않습니다.' });
  const source = `https://www.safetykorea.kr/search/searchPop?certNum=${encodeURIComponent(no)}`;
  const key = new Request(`https://kc-cache.invalid/${encodeURIComponent(no)}`);
  const cache = caches.default;
  let html;
  const hit = await cache.match(key);
  if (hit) html = await hit.text();
  else {
    try {
      const res = await fetch(source, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-sales-helper/1.0)', Accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      console.log(JSON.stringify({ kcFail: String(e?.message || e).slice(0, 200) }));
      return reply(502, { error: 'kc-fetch', message: '제품안전정보센터에 연결하지 못했습니다.', source });
    }
    if (html.includes('인증정보')) {
      ctx?.waitUntil(cache.put(key, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=21600' } })));
    }
  }
  if (html.includes(KC_NOT_FOUND)) return reply(200, { found: false, certNum: no, source });
  const cell = label => {
    const m = html.match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
    return m ? m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() : '';
  };
  const info = {
    found: true, certNum: cell('인증번호') || no, state: cell('인증상태'), date: cell('인증일자'), div: cell('인증구분'),
    product: cell('제품명'), model: cell('모델명'), brand: cell('브랜드명'), category: cell('제품분류코드'),
    maker: cell('제조사'), country: cell('제조국'), source,
  };
  if (!info.state && !info.product) return reply(502, { error: 'kc-parse', message: '조회 결과를 읽지 못했습니다.', source });
  return reply(200, info);
}

// 사진이 있으면 글과 사진을 함께 보내는 형식(OpenAI 방식)으로 만든다.
function userContent(text, images) {
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
}

function isLimit(e) {
  return /neuron|quota|daily|limit|4006|exceeded/i.test(String(e?.message || e));
}

// 모델마다 답 모양이 조금씩 달라 여러 경우를 처리한다.
function extractJSON(out) {
  let v = out?.choices ? out.choices[0]?.message?.content : (out?.response ?? out);
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  v = v.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = v.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) v = fenced[1];
  const start = v.indexOf('{');
  const end = v.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(v.slice(start, end + 1)); } catch { return null; }
}
