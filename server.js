const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// .env 파일이 있으면 로드 (로컬 개발용, npm dotenv 없이 동작)
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    });
  } catch (_) { /* .env 없으면 무시 */ }
})();

const PORT = 3000;
const XML_PATH = path.join(__dirname, 'corp.xml');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DART_API_KEY = process.env.DART_API_KEY || '';
const GEMINI_KEY   = process.env.GEMINI_KEY   || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

let corpList = [];

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

function loadCorpData() {
  console.log('corp.xml 로딩 중...');
  const xmlContent = fs.readFileSync(XML_PATH, 'utf8');
  corpList = parseXML(xmlContent);
  console.log(`총 ${corpList.length}개 기업 데이터 로드 완료`);
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
function getMimeType(filePath) {
  const mimes = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
  };
  return mimes[path.extname(filePath).toLowerCase()] || 'text/plain';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ──── DART API ────────────────────────────────────────────
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.end();
  });
}

// ──── 네이버 토론방 API ──────────────────────────────────────
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
  // 한글 2글자 이상 토큰 추출
  const words = text.match(/[가-힣]{2,}/g) || [];
  return words.filter(w => {
    if (DISCUSSION_STOPWORDS.has(w)) return false;
    if (VERB_SUFFIXES.some(s => w.endsWith(s))) return false;
    return true;
  });
}

function fetchDiscussion(itemCode) {
  return new Promise((resolve, reject) => {
    const path = `/front-api/discussion/list?discussionType=domesticStock&itemCode=${itemCode}&pageSize=20&isHolderOnly=false&excludesItemNews=false&isItemNewsOnly=false`;
    const options = {
      hostname: 'm.stock.naver.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

          // 최신 5개 포스트
          const latestPosts = posts.slice(0, 5).map(p => ({
            title:     p.title || '',
            content:   (p.contentSwReplaced || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').slice(0, 200),
            writtenAt: p.writtenAt || '',
            url:       p.id ? `https://m.stock.naver.com/domestic/stock/${itemCode}/discussion/${p.id}` : `https://m.stock.naver.com/domestic/stock/${itemCode}/discussion`,
          }));

          // 키워드 카운트
          const freq = {};
          posts.forEach(p => {
            const text = `${p.title || ''} ${p.contentSwReplaced || ''}`;
            tokenizeKo(text).forEach(w => { freq[w] = (freq[w] || 0) + 1; });
          });
          const keywords = Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([w, c]) => [w, c]);

          resolve({ success: true, keywords, latestPosts });
        } catch(e) { resolve({ success: false, keywords: [], latestPosts: [] }); }
      });
    });
    req.on('error', () => resolve({ success: false, keywords: [], latestPosts: [] }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, keywords: [], latestPosts: [] }); });
    req.end();
  });
}

function fetchDartList(params) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const options = {
      hostname: 'opendart.fss.or.kr',
      path: `/api/list.json?${qs}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://opendart.fss.or.kr/',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('DART 목록 API 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.end();
  });
}

function fetchDartAPI(params) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const options = {
      hostname: 'opendart.fss.or.kr',
      path: `/api/fnlttSinglAcnt.json?${qs}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://opendart.fss.or.kr/',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('DART API 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.end();
  });
}

// ──── Gemini API ──────────────────────────────────────────
function callGemini(model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Gemini 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gemini 요청 시간 초과')); });
    req.write(body);
    req.end();
  });
}


function amtToKor(str) {
  if (!str || !str.trim() || str.trim() === '-') return '-';
  const v = parseFloat(str.replace(/,/g, ''));
  if (!v) return '-';
  const eok = v / 1e8;
  if (Math.abs(eok) >= 10000) return `${(eok / 10000).toFixed(1)}조원`;
  if (Math.abs(eok) >= 1)     return `${Math.round(eok).toLocaleString()}억원`;
  return `${Math.round(v / 1e4).toLocaleString()}만원`;
}

function pctStr(amt, base) {
  const a = parseFloat((amt  || '0').replace(/,/g, ''));
  const b = parseFloat((base || '1').replace(/,/g, ''));
  if (!b) return '-';
  return `${(a / b * 100).toFixed(1)}%`;
}

function buildFinancialPrompt(corpName, year, fsDiv, list, discussionData = null) {
  const items = list.filter(i => i.fs_div === fsDiv);
  if (!items.length) return null;

  const get = (sj, nm) => items.find(i => i.sj_div === sj && i.account_nm === nm);

  const revenue  = get('IS', '매출액');
  const opProfit = get('IS', '영업이익');
  const netInc   = get('IS', '당기순이익(손실)') || get('IS', '당기순이익');
  const assets   = get('BS', '자산총계');
  const liab     = get('BS', '부채총계');
  const equity   = get('BS', '자본총계');

  const fsNm = items[0]?.fs_nm || (fsDiv === 'CFS' ? '연결재무제표' : '재무제표');
  const y = [year - 2, year - 1, year];

  const row = (item, label) => {
    if (!item) return `| ${label} | - | - | - |`;
    return `| ${label} | ${amtToKor(item.bfefrmtrm_amount)} | ${amtToKor(item.frmtrm_amount)} | ${amtToKor(item.thstrm_amount)} |`;
  };

  const opRate = [
    revenue && opProfit ? pctStr(opProfit.bfefrmtrm_amount, revenue.bfefrmtrm_amount) : '-',
    revenue && opProfit ? pctStr(opProfit.frmtrm_amount,    revenue.frmtrm_amount)    : '-',
    revenue && opProfit ? pctStr(opProfit.thstrm_amount,    revenue.thstrm_amount)    : '-',
  ];
  const netRate = [
    revenue && netInc ? pctStr(netInc.bfefrmtrm_amount, revenue.bfefrmtrm_amount) : '-',
    revenue && netInc ? pctStr(netInc.frmtrm_amount,    revenue.frmtrm_amount)    : '-',
    revenue && netInc ? pctStr(netInc.thstrm_amount,    revenue.thstrm_amount)    : '-',
  ];
  const debtRate = [
    liab && equity ? pctStr(liab.bfefrmtrm_amount, equity.bfefrmtrm_amount) : '-',
    liab && equity ? pctStr(liab.frmtrm_amount,    equity.frmtrm_amount)    : '-',
    liab && equity ? pctStr(liab.thstrm_amount,    equity.thstrm_amount)    : '-',
  ];

  let prompt = `당신은 재무 분석 전문가이자 친절한 선생님입니다.
아래 기업의 재무 데이터를 분석하여 재무 지식이 전혀 없는 일반인도 이해할 수 있도록 설명해주세요.

**기업명**: ${corpName}
**분석 기간**: ${y[0]}년 ~ ${y[2]}년
**재무제표 유형**: ${fsNm} (사업보고서)

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

## ⭐ 이것만은 알아두세요
(일반인이 주목해야 할 핵심 포인트 3가지를 번호로)`;

  // 토론방 데이터가 있으면 추가 섹션 삽입
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
(위 투자자 토론방 데이터를 바탕으로 현재 시장 참여자들이 주목하는 이슈와 관심사를 분석하고, 위 재무 데이터와 연결하여 일반인도 이해하기 쉽게 설명해주세요. 키워드에서 느껴지는 시장 분위기와 재무 실적의 연관성, 그리고 투자자 관점에서 주목해야 할 점을 포함해주세요.)`;
  }

  return prompt;
}

// ──── HTTP Server ─────────────────────────────────────────
async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  // ── DART 정기공시 목록
  if (pathname === '/api/reports') {
    const { corp_code } = query;
    if (!corp_code) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'corp_code required' }));
      return;
    }
    // 최근 3년치 정기공시 조회
    const today = new Date();
    const bgn = `${today.getFullYear() - 3}0101`;
    const raw = await fetchDartList({
      crtfc_key: DART_API_KEY,
      corp_code,
      bgn_de: bgn,
      pblntf_ty: 'A',   // 정기공시
      page_count: 40,
    });

    if (!raw || raw.status !== '000') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ list: [] }));
      return;
    }

    // 분석 가능한 보고서만 필터링 + bsns_year / reprt_code 추론
    const VALID = ['사업보고서','반기보고서','분기보고서','1분기보고서','3분기보고서'];
    const enriched = (raw.list || [])
      .filter(r => VALID.some(k => r.report_nm.includes(k)))
      .map(r => {
        const nm   = r.report_nm;
        const yr   = parseInt(r.rcept_dt.substring(0, 4));
        const mon  = parseInt(r.rcept_dt.substring(4, 6));
        let reprt_code, bsns_year;

        if (nm.includes('사업보고서')) {
          reprt_code = '11011';
          bsns_year  = mon <= 6 ? yr - 1 : yr;
        } else if (nm.includes('반기보고서')) {
          reprt_code = '11012';
          bsns_year  = yr;
        } else if (nm.includes('1분기') || (nm.includes('분기') && (mon >= 4 && mon <= 7))) {
          reprt_code = '11013';
          bsns_year  = yr;
        } else {
          reprt_code = '11014';
          bsns_year  = yr;
        }
        return { ...r, reprt_code, bsns_year };
      });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ list: enriched }));
    return;
  }

  // ── Naver 토론방 키워드 + 최신글 proxy
  if (pathname === '/api/discussion') {
    const { code } = query;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'code required' }));
      return;
    }
    const result = await fetchDiscussion(code);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Naver stock chart proxy
  if (pathname === '/api/stock-chart') {
    const { code } = query;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'code required' }));
      return;
    }
    const data = await fetchNaverStock(code);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  // ── Financial data proxy
  if (pathname === '/api/financial') {
    const { corp_code, bsns_year, reprt_code } = query;
    if (!corp_code || !bsns_year) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ERR', message: 'corp_code, bsns_year 필수' }));
      return;
    }
    const data = await fetchDartAPI({
      crtfc_key: DART_API_KEY,
      corp_code,
      bsns_year,
      reprt_code: reprt_code || '11011',
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  // ── AI Analysis
  if (pathname === '/api/analyze' && req.method === 'POST') {
    const bodyStr = await readBody(req);
    const { corpName, year, fsDiv, list, discussionData } = JSON.parse(bodyStr);

    const prompt = buildFinancialPrompt(corpName, parseInt(year), fsDiv, list, discussionData);
    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '분석할 데이터가 없습니다' }));
      return;
    }

    const geminiRes = await callGemini(GEMINI_MODEL, prompt);

    if (geminiRes.error) {
      throw new Error(geminiRes.error.message || 'Gemini API 오류');
    }

    let analysis = geminiRes.candidates?.[0]?.content?.parts?.[0]?.text
      || '분석 결과를 가져올 수 없습니다.';

    // 렌더링 불가 제어 문자 제거 (이모지는 유지)
    analysis = analysis.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '');

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ analysis, model: GEMINI_MODEL }));
    return;
  }

  // ── Static files
  const filePath = pathname === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, pathname);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

loadCorpData();
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
