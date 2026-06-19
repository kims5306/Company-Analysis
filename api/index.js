// Vercel Serverless Function — API 핸들러
// server.js에서 HTTP 서버 / 정적 파일 서빙 부분을 제거하고 Vercel 형식으로 변환
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// API 키는 환경변수에서만 로드 (Vercel 환경변수 또는 로컬 .env)
const DART_API_KEY = process.env.DART_API_KEY || '';
const GEMINI_KEY   = process.env.GEMINI_KEY   || '';
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

// corp.xml은 프로젝트 루트에 위치
const XML_PATH = path.join(process.cwd(), 'corp.xml');

let corpList = [];
let corpLoaded = false;

// AI 분석 캐시 (모듈 스코프 — 같은 serverless 인스턴스 재사용 시 즉시 응답·Gemini 호출/토큰 절약).
// Vercel은 stateless지만 웜 인스턴스가 흔히 재사용돼 효과적. TTL 12시간.
const analysisCache = new Map();
const ANALYSIS_TTL = 12 * 3600 * 1000;
const ANALYSIS_CACHE_MAX = 200;
function cacheGet(key) {
  const e = analysisCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > ANALYSIS_TTL) { analysisCache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) {
  if (analysisCache.size >= ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    analysisCache.delete(oldest);
  }
  analysisCache.set(key, { ts: Date.now(), value });
}
// 캐시 키용 경량 해시(djb2)
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ──── Corp XML ────────────────────────────────────────────
function parseXML(xmlContent) {
  const results = [];
  const listRegex = /<list>([\s\S]*?)<\/list>/g;
  const fieldRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let listMatch;
  while ((listMatch = listRegex.exec(xmlContent)) !== null) {
    const block = listMatch[1];
    const item = {};
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(block)) !== null) {
      item[fieldMatch[1]] = fieldMatch[2].trim();
    }
    if (item.corp_code) results.push(item);
  }
  return results;
}

function ensureCorpLoaded() {
  if (corpLoaded) return;
  try {
    const xml = fs.readFileSync(XML_PATH, 'utf8');
    corpList = parseXML(xml);
    corpLoaded = true;
  } catch (e) {
    console.error('corp.xml 로드 실패:', e.message);
  }
}

function searchCorps(query, limit = 100) {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  return corpList.filter(corp =>
    (corp.corp_name     && corp.corp_name.toLowerCase().includes(q)) ||
    (corp.corp_eng_name && corp.corp_eng_name.toLowerCase().includes(q)) ||
    (corp.corp_code     && corp.corp_code.includes(q)) ||
    (corp.stock_code    && corp.stock_code.includes(q))
  ).slice(0, limit);
}

// ──── Utilities ───────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ──── Naver Stock ─────────────────────────────────────────
function fetchNaverStock(code) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stock.naver.com',
      path: `/chart/domestic/item/${code}?periodType=dayCandle`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': `https://m.stock.naver.com/item/home/${code}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Naver API 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.end();
  });
}

// ──── 네이버 토론방 ───────────────────────────────────────
const DISCUSSION_STOPWORDS = new Set([
  '그리고','하지만','그러나','그래서','이번','오늘','내일','이번주','지난달','지난주','관련','등등',
  '에서','으로','하면','하는','대해','대한','까지','부터','으로써','같은','이런','저런','그런','많은',
  '해서','아니라','아니고','이나','거나','이며','또는','혹은','때문','때문에','약간','정도','최근','지난','기준',
  '주가','주식','종목','시장','기업','국내','해외','대한민국','네이버','토론','게시글','댓글','분석','정보','뉴스','기사',
  '있다','있습니다','없다','없습니다','없는','없음','이다','입니다','합니다','했다','됩니다','된다','되는','되다',
  '하였다','한다','하는데','같습니다','같아요','네요','예요','에요','br','BR',
]);
const VERB_SUFFIXES = ['니다','합니다','됩니다','해요','돼요','했어요','했음','했다','한다','되는','된다','이었다','였다','라고','겠어요','겠음'];

function tokenizeKo(text) {
  const words = text.match(/[가-힣]{2,}/g) || [];
  return words.filter(w => {
    if (DISCUSSION_STOPWORDS.has(w)) return false;
    if (VERB_SUFFIXES.some(s => w.endsWith(s))) return false;
    return true;
  });
}

function fetchDiscussion(itemCode) {
  return new Promise((resolve) => {
    const reqPath = `/front-api/discussion/list?discussionType=domesticStock&itemCode=${itemCode}&pageSize=20&isHolderOnly=false&excludesItemNews=false&isItemNewsOnly=false`;
    const options = {
      hostname: 'm.stock.naver.com',
      path: reqPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': `https://m.stock.naver.com/domestic/stock/${itemCode}/discussion`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          const posts = (payload.result && payload.result.posts) ? payload.result.posts : [];
          const latestPosts = posts.slice(0, 5).map(p => ({
            title:     p.title || '',
            content:   (p.contentSwReplaced || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').slice(0, 200),
            writtenAt: p.writtenAt || '',
            url:       p.id ? `https://m.stock.naver.com/domestic/stock/${itemCode}/discussion/${p.id}` : `https://m.stock.naver.com/domestic/stock/${itemCode}/discussion`,
          }));
          const freq = {};
          posts.forEach(p => {
            const text = `${p.title || ''} ${p.contentSwReplaced || ''}`;
            tokenizeKo(text).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
          });
          const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w, c]) => [w, c]);
          resolve({ success: true, keywords, latestPosts });
        } catch(e) { resolve({ success: false, keywords: [], latestPosts: [] }); }
      });
    });
    req.on('error', () => resolve({ success: false, keywords: [], latestPosts: [] }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ success: false, keywords: [], latestPosts: [] }); });
    req.end();
  });
}

// ──── DART API ────────────────────────────────────────────
function dartRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // DART는 종종 302 redirect를 보냄
      if (res.statusCode === 302 && res.headers.location) {
        reject(new Error(`DART redirect: ${res.headers.location}`));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('DART API 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('DART 요청 시간 초과')); });
    req.end();
  });
}

function fetchDartAPI(params, endpoint) {
  const ep = endpoint || 'fnlttSinglAcnt';  // 기본=요약본(프론트 차트/표가 쓰는 그것). All은 호출부에서 명시.
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return dartRequest({
    hostname: 'opendart.fss.or.kr',
    path: `/api/${ep}.json?${qs}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://opendart.fss.or.kr/',
    },
  });
}

// 현금흐름표(CF)만 별도 조회 — AI 분석 프롬프트에만 사용(차트/표는 기존 요약본 그대로).
// 전체계정 API에서 CF 항목만 추려 반환. 실패해도 분석은 정상 진행(현금흐름 섹션만 생략).
async function fetchCashFlow(baseParams, fsDiv) {
  const fs = fsDiv === 'OFS' ? 'OFS' : 'CFS';
  try {
    const d = await fetchDartAPI({ ...baseParams, fs_div: fs }, 'fnlttSinglAcntAll');
    if (!d || d.status !== '000' || !Array.isArray(d.list)) return [];
    return d.list.filter(it => it.sj_div === 'CF');
  } catch (e) { return []; }
}

function fetchDartList(params) {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return dartRequest({
    hostname: 'opendart.fss.or.kr',
    path: `/api/list.json?${qs}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://opendart.fss.or.kr/',
    },
  });
}

// ──── Gemini AI ───────────────────────────────────────────
function callGemini(model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Gemini API 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error('Gemini 요청 시간 초과')); });
    req.write(body);
    req.end();
  });
}

// ──── 재무 프롬프트 빌더 ──────────────────────────────────
function amtToKor(str) {
  if (!str || !str.trim() || str.trim() === '-') return '-';
  const n = parseFloat(str.replace(/,/g, ''));
  if (isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(1) + '조원';
  if (a >= 1e8)  return (n / 1e8).toFixed(1) + '억원';
  if (a >= 1e4)  return (n / 1e4).toFixed(1) + '만원';
  return n.toLocaleString() + '원';
}

function pctStr(num, den) {
  if (!num || !den) return '-';
  const n = parseFloat(num.replace(/,/g, ''));
  const d = parseFloat(den.replace(/,/g, ''));
  if (!d) return '-';
  return (n / d * 100).toFixed(1) + '%';
}

function buildFinancialPrompt(corpName, year, fsDiv, list, discussionData = null, cfItems = []) {
  const items = list.filter(i => i.fs_div === fsDiv);
  if (!items.length) return null;
  const get = (sj, nm) => items.find(i => i.sj_div === sj && i.account_nm === nm);
  const revenue  = get('IS', '매출액');
  const opProfit = get('IS', '영업이익');
  const netInc   = get('IS', '당기순이익(손실)') || get('IS', '당기순이익');
  const assets   = get('BS', '자산총계');
  const liab     = get('BS', '부채총계');
  const equity   = get('BS', '자본총계');
  // 현금흐름표 — 별도 조회한 cfItems(전체계정 API의 CF 항목)에서 찾음. 없으면 표 자동 생략.
  const getCF = (nm) => (cfItems || []).find(i => i.account_nm === nm);
  const cfo = getCF('영업활동현금흐름');
  const cfi = getCF('투자활동현금흐름');
  const cff = getCF('재무활동현금흐름');
  const fsNm = items[0]?.fs_nm || (fsDiv === 'CFS' ? '연결재무제표' : '재무제표');
  const y = [year - 2, year - 1, year];
  const row = (item, label) => {
    if (!item) return `| ${label} | - | - | - |`;
    return `| ${label} | ${amtToKor(item.bfefrmtrm_amount)} | ${amtToKor(item.frmtrm_amount)} | ${amtToKor(item.thstrm_amount)} |`;
  };
  const opRate  = y.map((_, i) => i===0 ? pctStr(opProfit?.bfefrmtrm_amount, revenue?.bfefrmtrm_amount) : i===1 ? pctStr(opProfit?.frmtrm_amount, revenue?.frmtrm_amount) : pctStr(opProfit?.thstrm_amount, revenue?.thstrm_amount));
  const netRate = y.map((_, i) => i===0 ? pctStr(netInc?.bfefrmtrm_amount, revenue?.bfefrmtrm_amount) : i===1 ? pctStr(netInc?.frmtrm_amount, revenue?.frmtrm_amount) : pctStr(netInc?.thstrm_amount, revenue?.thstrm_amount));
  const debtRate = y.map((_, i) => i===0 ? pctStr(liab?.bfefrmtrm_amount, equity?.bfefrmtrm_amount) : i===1 ? pctStr(liab?.frmtrm_amount, equity?.frmtrm_amount) : pctStr(liab?.thstrm_amount, equity?.thstrm_amount));

  let prompt = `당신은 재무 분석 전문가이자 친절한 선생님입니다.
아래 기업의 재무 데이터를 분석하여 재무 지식이 전혀 없는 일반인도 이해할 수 있도록 설명해주세요.

**기업명**: ${corpName}
**분석 기간**: ${y[0]}년 ~ ${y[2]}년
**재무제표 유형**: ${fsNm}

---

### 손익계산서
| 항목 | ${y[0]}년 | ${y[1]}년 | ${y[2]}년 |
|------|---------|---------|---------|
${row(revenue,  '매출액')}
${row(opProfit, '영업이익')}
${row(netInc,   '당기순이익')}

### 재무상태표
| 항목 | ${y[0]}년 | ${y[1]}년 | ${y[2]}년 |
|------|---------|---------|---------|
${row(assets, '자산총계')}
${row(liab,   '부채총계')}
${row(equity, '자본총계')}
${(cfo || cfi || cff) ? `
### 현금흐름표 (실제로 들어온 현금 기준)
| 항목 | ${y[0]}년 | ${y[1]}년 | ${y[2]}년 |
|------|---------|---------|---------|
${row(cfo, '영업활동현금흐름')}
${row(cfi, '투자활동현금흐름')}
${row(cff, '재무활동현금흐름')}
` : ''}
### 주요 지표
| 지표 | ${y[0]}년 | ${y[1]}년 | ${y[2]}년 |
|------|---------|---------|---------|
| 영업이익률 | ${opRate[0]} | ${opRate[1]} | ${opRate[2]} |
| 순이익률   | ${netRate[0]} | ${netRate[1]} | ${netRate[2]} |
| 부채비율   | ${debtRate[0]} | ${debtRate[1]} | ${debtRate[2]} |

---

위 데이터를 바탕으로 아래 형식에 맞춰 한국어로 분석해주세요.
전문 용어 사용 시 반드시 괄호 안에 쉬운 설명을 추가하고, 구체적인 수치를 활용해 근거를 제시해주세요.

## 📊 한눈에 보는 핵심 요약
(2~3문장으로 가장 중요한 내용 요약)

## 📈 매출 & 성장성
(매출 성장 추이와 의미를 쉽게 설명)

## 💰 돈은 잘 버나요? (수익성)
(영업이익률·순이익률의 의미와 변화를 쉽게 설명)

## 🏦 빚은 얼마나 있나요? (재무 건전성)
(부채비율과 자본 구조의 안전성 설명)
${(cfo || cfi || cff) ? `
## 💵 진짜 현금은 잘 돌고 있나요? (현금흐름)
(영업활동현금흐름이 플러스인지, 당기순이익과 비교해 '장부상 이익은 나는데 실제 현금은 마르는' 흑자도산 위험은 없는지 쉽게 설명. 투자활동·재무활동 현금흐름의 방향이 무엇을 의미하는지도 한 줄씩.)
` : ''}
## ⭐ 이것만은 알아두세요
(일반인이 주목해야 할 핵심 포인트 3가지를 번호로)`;

  if (discussionData && discussionData.success) {
    const topKw    = (discussionData.keywords || []).slice(0, 15).map(([w]) => w).join(', ');
    const posts    = (discussionData.latestPosts || []).slice(0, 5);
    const postLines = posts.map((p, i) => {
      const dt = p.writtenAt ? ' (' + new Date(p.writtenAt).toLocaleDateString('ko-KR') + ')' : '';
      return `  ${i + 1}. ${p.title}${dt}`;
    }).join('\n');
    prompt += `

---

### 투자자 토론방 데이터 (최근 1개월 기준)
**주요 관심 키워드**: ${topKw || '데이터 없음'}

**최근 이슈 토론 (${posts.length}개)**:
${postLines}

## 💬 시장 이슈 & 투자자 관심
(위 투자자 토론방 데이터를 바탕으로 현재 시장 참여자들이 주목하는 이슈와 관심사를 분석하고, 위 재무 데이터와 연결하여 일반인도 이해하기 쉽게 설명해주세요.)`;
  }
  return prompt;
}

// ──── 메인 핸들러 ─────────────────────────────────────────
module.exports = async (req, res) => {
  ensureCorpLoaded();

  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── Search
    if (pathname === '/api/search') {
      const results = searchCorps(query.q || '', parseInt(query.limit) || 100);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: results.length, results }));
      return;
    }

    // ── Stats
    if (pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: corpList.length }));
      return;
    }

    // ── 정기공시 목록
    if (pathname === '/api/reports') {
      const { corp_code } = query;
      if (!corp_code) { res.writeHead(400); res.end(JSON.stringify({ error: 'corp_code required' })); return; }
      const today = new Date();
      const bgn = `${today.getFullYear() - 3}0101`;
      const raw = await fetchDartList({ crtfc_key: DART_API_KEY, corp_code, bgn_de: bgn, pblntf_ty: 'A', page_count: 40 });
      if (!raw || raw.status !== '000') { res.writeHead(200); res.end(JSON.stringify({ list: [] })); return; }
      const VALID = ['사업보고서','반기보고서','분기보고서','1분기보고서','3분기보고서'];
      const enriched = (raw.list || []).filter(r => VALID.some(k => r.report_nm.includes(k))).map(r => {
        const nm = r.report_nm;
        const yr = parseInt(r.rcept_dt.substring(0, 4));
        const mon = parseInt(r.rcept_dt.substring(4, 6));
        let reprt_code, bsns_year;
        if (nm.includes('사업보고서'))      { reprt_code = '11011'; bsns_year = mon <= 6 ? yr - 1 : yr; }
        else if (nm.includes('반기보고서')) { reprt_code = '11012'; bsns_year = yr; }
        else if (nm.includes('1분기'))      { reprt_code = '11013'; bsns_year = yr; }
        else                                { reprt_code = '11014'; bsns_year = yr; }
        return { ...r, reprt_code, bsns_year };
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ list: enriched }));
      return;
    }

    // ── 토론방
    if (pathname === '/api/discussion') {
      const { code } = query;
      if (!code) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'code required' })); return; }
      const result = await fetchDiscussion(code);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── 주식 차트
    if (pathname === '/api/stock-chart') {
      const { code } = query;
      if (!code) { res.writeHead(400); res.end(JSON.stringify({ error: 'code required' })); return; }
      const data = await fetchNaverStock(code);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    // ── 재무 데이터
    if (pathname === '/api/financial') {
      const { corp_code, bsns_year, reprt_code } = query;
      if (!corp_code || !bsns_year) { res.writeHead(400); res.end(JSON.stringify({ status: 'ERR', message: 'corp_code, bsns_year 필수' })); return; }
      const data = await fetchDartAPI({ crtfc_key: DART_API_KEY, corp_code, bsns_year, reprt_code: reprt_code || '11011' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    // ── AI 분석
    if (pathname === '/api/analyze' && req.method === 'POST') {
      const bodyStr = await readBody(req);
      const { corpName, corpCode, reprtCode, year, fsDiv, list, discussionData } = JSON.parse(bodyStr);
      // 현금흐름표(CF)는 요약본(list)에 없음 → 분석 시점에만 전체계정 API로 별도 조회.
      // 차트/표가 쓰는 financial 엔드포인트는 건드리지 않음(요약본 그대로).
      let cfItems = [];
      if (corpCode) {
        try {
          cfItems = await fetchCashFlow(
            { crtfc_key: DART_API_KEY, corp_code: corpCode, bsns_year: String(year), reprt_code: reprtCode || '11011' },
            fsDiv
          );  // 이미 CF 항목만 추려진 배열을 반환
        } catch (e) { console.error('CF 조회 실패(분석 계속):', e.message); }
      }
      const prompt = buildFinancialPrompt(corpName, parseInt(year), fsDiv, list, discussionData, cfItems);
      if (!prompt) { res.writeHead(400); res.end(JSON.stringify({ error: '분석할 데이터가 없습니다' })); return; }
      // 캐시 키 = 기업·연도·재무구분 + 프롬프트 해시(토론방 포함 내용 바뀌면 새로 분석)
      const cacheKey = `${corpName}|${year}|${fsDiv}|${prompt.length}|${hashStr(prompt)}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ analysis: cached, model: GEMINI_MODEL, cached: true }));
        return;
      }
      const geminiRes = await callGemini(GEMINI_MODEL, prompt);
      if (geminiRes.error) throw new Error(geminiRes.error.message || 'Gemini API 오류');
      let analysis = geminiRes.candidates?.[0]?.content?.parts?.[0]?.text || '분석 결과를 가져올 수 없습니다.';
      analysis = analysis.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '');
      cacheSet(cacheKey, analysis);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ analysis, model: GEMINI_MODEL, cached: false }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));

  } catch (err) {
    console.error('API Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
};
