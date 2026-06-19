// Vercel Serverless Function — API 핸들러
// server.js에서 HTTP 서버 / 정적 파일 서빙 부분을 제거하고 Vercel 형식으로 변환
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zlib  = require('zlib');

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

// ──── 재무 분기 시계열 (ver2.0 세부정보 탭) ────────────────────
// 최근 N년 × 4분기 BS/IS/CF 전체계정을 긁어 분기 연속 시계열로 가공.
// 재무상태표·손익·현금흐름 탭의 모든 차트가 이 한 응답을 나눠 씀. 온디맨드+캐싱.
const seriesCache = new Map();
const SERIES_TTL = 12 * 3600 * 1000;   // 분기 확정자료라 12h 충분
const SERIES_CACHE_MAX = 100;
function seriesGet(key) {
  const e = seriesCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > SERIES_TTL) { seriesCache.delete(key); return null; }
  return e.value;
}
function seriesSet(key, value) {
  if (seriesCache.size >= SERIES_CACHE_MAX) seriesCache.delete(seriesCache.keys().next().value);
  seriesCache.set(key, { ts: Date.now(), value });
}
// 계정명 정규화(띄어쓰기 변동 — 분기 "영업활동 현금흐름" vs 연간 "영업활동현금흐름")
function normNm(s) { return (s || '').replace(/\s+/g, ''); }
function toNum(s) { const n = parseFloat(String(s || '').replace(/,/g, '')); return isNaN(n) ? null : n; }

// 한 보고서(분기)의 list에서 sj_div+정규화 계정명으로 분기값·누적값 둘 다 추출.
// IS는 thstrm_amount(분기)·thstrm_add_amount(누적) 둘 다 제공. CF/BS는 thstrm_amount만.
function pickField(list, sjDiv, accountNm) {
  const target = normNm(accountNm);
  const hit = (list || []).find(i => i.sj_div === sjDiv && normNm(i.account_nm) === target);
  if (!hit) return { amt: null, add: null };
  return { amt: toNum(hit.thstrm_amount), add: toNum(hit.thstrm_add_amount) };
}

// 재무 분기 시계열. 각 분기 포인트에 quarter(분기단독)·cumulative(누적) 둘 다 담는다.
//  - BS: 시점값(quarter=cumulative=동일)
//  - IS: 분기=thstrm_amount, 누적=thstrm_add_amount (4Q는 add없음→누적=연간값, 분기=연−3Q누적)
//  - CF: thstrm_amount가 누적 → 누적=그대로, 분기=차분(2Q=반기−1Q…)
async function fetchFinancialSeries(corpCode, years, fsDiv) {
  const fs = fsDiv === 'OFS' ? 'OFS' : 'CFS';
  const REPRT = [['1Q', '11013'], ['2Q', '11012'], ['3Q', '11014'], ['4Q', '11011']];
  const now = new Date();
  const curY = now.getFullYear();
  const startY = curY - (years - 1);
  const BS_ACCTS = ['자산총계','유동자산','비유동자산','부채총계','유동부채','비유동부채','자본총계','자본금','이익잉여금','유형자산','매출채권','재고자산','매입채무'];
  const IS_ACCTS = ['매출액','매출원가','매출총이익','영업이익','당기순이익(손실)','당기순이익','분기순이익(손실)','반기순이익(손실)','반기순이익','분기순이익','법인세비용차감전순이익','판매비와관리비'];
  const CF_ACCTS = ['영업활동현금흐름','투자활동현금흐름','재무활동현금흐름','유형자산의취득','유형자산의처분','감가상각비'];

  // 보고서별 원시 수집: raw[y][q] = {bs:{acct:val}, is:{acct:{amt,add}}, cf:{acct:val}}
  const raw = {};
  for (let y = startY; y <= curY; y++) {
    raw[y] = {};
    for (const [q, rc] of REPRT) {
      let d;
      try { d = await fetchDartAPI({ crtfc_key: DART_API_KEY, corp_code: corpCode, bsns_year: String(y), reprt_code: rc, fs_div: fs }, 'fnlttSinglAcntAll'); }
      catch (e) { d = null; }
      if (!d || d.status !== '000' || !Array.isArray(d.list)) { raw[y][q] = null; continue; }
      const bs = {}; BS_ACCTS.forEach(a => { bs[a] = pickField(d.list, 'BS', a).amt; });
      const is = {}; IS_ACCTS.forEach(a => { is[a] = pickField(d.list, 'IS', a); });   // {amt,add}
      // 순이익 자동탐색(계정명 변형: 당기/분기/반기순이익 ± (손실), 법인세·주당·계속영업 제외)
      const niHit = d.list.find(it => it.sj_div === 'IS' && /(당기|분기|반기)순이익/.test(normNm(it.account_nm)) && !/주당|법인세|계속영업|중단/.test(normNm(it.account_nm)));
      is._ni = niHit ? { amt: toNum(niHit.thstrm_amount), add: toNum(niHit.thstrm_add_amount) } : { amt: null, add: null };
      const cf = {}; CF_ACCTS.forEach(a => { cf[a] = pickField(d.list, 'CF', a).amt; });
      raw[y][q] = { bs, is, cf };
    }
  }

  const ORDER = ['1Q', '2Q', '3Q', '4Q'];
  const points = [];
  for (let y = startY; y <= curY; y++) {
    for (let qi = 0; qi < 4; qi++) {
      const q = ORDER[qi];
      const snap = raw[y] && raw[y][q];
      if (!snap) continue;
      const prev = qi === 0 ? null : (raw[y] && raw[y][ORDER[qi - 1]]);

      const pt = { label: `${String(y).slice(2)}.${q.replace('Q','')}Q`, year: y, q,
                   bs: {}, isQ: {}, isC: {}, cfQ: {}, cfC: {} };
      // BS = 시점값
      BS_ACCTS.forEach(a => { pt.bs[a] = snap.bs ? snap.bs[a] : null; });
      // IS = 분기(amt)·누적(add). 4Q는 add없음 → 누적=amt(연간), 분기=연간−3Q누적
      // _ni(순이익 자동탐색값)도 동일 차분 로직 적용
      [...IS_ACCTS, '_ni'].forEach(a => {
        const cur = snap.is ? snap.is[a] : null;
        if (!cur) { pt.isQ[a] = null; pt.isC[a] = null; return; }
        // 누적
        if (cur.add != null) pt.isC[a] = cur.add;
        else pt.isC[a] = cur.amt;                       // 4Q: thstrm=연간=누적
        // 분기
        if (cur.amt != null && cur.add != null) pt.isQ[a] = cur.amt;   // 1~3Q: thstrm=분기단독
        else if (q === '4Q') {                                          // 4Q: 연간−3Q누적
          const p3 = prev && prev.is && prev.is[a];
          const prevCum = p3 ? (p3.add != null ? p3.add : p3.amt) : null;
          pt.isQ[a] = (cur.amt != null && prevCum != null) ? cur.amt - prevCum : null;
        } else pt.isQ[a] = cur.amt;
      });
      // CF = thstrm가 누적. 누적=그대로, 분기=차분
      CF_ACCTS.forEach(a => {
        const cur = snap.cf ? snap.cf[a] : null;
        pt.cfC[a] = cur;                                  // 누적
        if (cur == null) { pt.cfQ[a] = null; return; }
        if (qi === 0) { pt.cfQ[a] = cur; return; }        // 1Q = 누적 자체
        const prevV = prev && prev.cf ? prev.cf[a] : null;
        pt.cfQ[a] = prevV == null ? null : cur - prevV;
      });
      points.push(pt);
    }
  }
  return { fsDiv: fs, years, points };
}

// ──── 밸류에이션 보조: 연도별 상장주식수 + 배당 (PER/PBR/EPS/DPS용) ────
// 주식수·배당은 사업보고서(연 1회)만 → 연도별 수집. 주가는 프론트가 네이버 일봉에서 매핑(여기선 미포함).
const DART_GENERIC_TTL = 12 * 3600 * 1000;
function genGet(cache, key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > DART_GENERIC_TTL) { cache.delete(key); return null; }
  return e.value;
}
function genSet(cache, key, value, max = 100) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), value });
}
const valuationCache = new Map();
const employeesCache = new Map();

async function dartJson(ep, params) {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return dartRequest({
    hostname: 'opendart.fss.or.kr',
    path: `/api/${ep}.json?${qs}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://opendart.fss.or.kr/',
    },
  });
}

// 연도별 상장주식수(보통주 발행총수) + 배당(주당배당·순이익·배당성향)
async function fetchValuationExtra(corpCode, years) {
  const curY = new Date().getFullYear();
  const startY = curY - (years - 1);
  const byYear = {};
  for (let y = startY; y <= curY; y++) {
    const rec = { shares: null, eps: null, dps: null, payout: null, divYield: null, netIncome: null };
    // 주식총수 — 보통주 발행총수
    try {
      const s = await dartJson('stockTotqySttus', { crtfc_key: DART_API_KEY, corp_code: corpCode, bsns_year: String(y), reprt_code: '11011' });
      if (s.status === '000' && Array.isArray(s.list)) {
        const ord = s.list.find(r => (r.se || '').includes('보통주'));
        if (ord) rec.shares = toNum(ord.istc_totqy);
      }
    } catch (e) {}
    // 배당 — alotMatter
    try {
      const d = await dartJson('alotMatter', { crtfc_key: DART_API_KEY, corp_code: corpCode, bsns_year: String(y), reprt_code: '11011' });
      if (d.status === '000' && Array.isArray(d.list)) {
        const pick = (kw) => { const r = d.list.find(x => (x.se || '').includes(kw)); return r ? toNum(r.thstrm) : null; };
        rec.eps = pick('주당순이익');                 // (연결)주당순이익(원)
        rec.netIncome = pick('당기순이익');            // 백만원
        rec.payout = pick('현금배당성향');             // %
        rec.divYield = pick('현금배당수익률');         // %
        // DPS = 주당 현금배당금(원). 배당총액/주식수로도 가능하나 직접 항목 우선
        const dpsRow = d.list.find(x => (x.se || '').includes('주당') && (x.se || '').includes('현금배당'));
        rec.dps = dpsRow ? toNum(dpsRow.thstrm) : null;
        rec.cashDivTotal = pick('현금배당금총액');     // 백만원
      }
    } catch (e) {}
    byYear[y] = rec;
  }
  return { years, byYear };
}

// 직원현황 — 최신 사업보고서 부문×성별 인원/근속/급여
async function fetchEmployees(corpCode, year) {
  const y = year || new Date().getFullYear();
  // 최신 연도부터 역순으로 데이터 있는 해 찾기(당해 사업보고서 아직 없을 수 있음)
  for (let yy = y; yy >= y - 2; yy--) {
    try {
      const d = await dartJson('empSttus', { crtfc_key: DART_API_KEY, corp_code: corpCode, bsns_year: String(yy), reprt_code: '11011' });
      if (d.status === '000' && Array.isArray(d.list) && d.list.length) {
        const rows = d.list.map(r => ({
          division: r.fo_bbm || '', sex: r.sexdstn || '',
          regular: toNum(r.rgllbr_co), contract: toNum(r.cnttk_co), total: toNum(r.sm),
          avgTenure: toNum(r.avrg_cnwk_sdytrn), avgSalary: toNum(r.jan_salary_am),
        }));
        return { year: yy, rows };
      }
    } catch (e) {}
  }
  return { year: y, rows: [] };
}

// ──── AI 사업요약: 사업보고서 원문에서 '사업의 개요' 추출 → Gemini 요약 ────
const bizSummaryCache = new Map();
// 바이너리 GET (zip)
function httpGetBuffer(hostname, pathStr) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: pathStr, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://opendart.fss.or.kr/' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('원문 다운로드 시간 초과')); });
    req.end();
  });
}
// 최소 zip 파서: 로컬 헤더 순회, deflate(8)/store(0) 첫 .xml 엔트리 추출
function unzipFirstXml(buf) {
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    if (/\.xml$/i.test(name)) {
      try {
        const out = method === 8 ? zlib.inflateRawSync(comp) : comp;
        return out.toString('utf8');
      } catch (e) { /* 다음 엔트리 */ }
    }
    off = dataStart + compSize;
  }
  return null;
}
async function fetchBusinessSummary(corpName, corpCode) {
  // 1) 최신 사업보고서 rcept_no
  const cury = new Date().getFullYear();
  let rcept = null;
  const listing = await dartJson('list', { crtfc_key: DART_API_KEY, corp_code: corpCode, bgn_de: `${cury - 2}0101`, pblntf_ty: 'A', page_count: '30' });
  if (listing.status === '000' && Array.isArray(listing.list)) {
    const biz = listing.list.find(r => /사업보고서/.test(r.report_nm || ''));
    if (biz) rcept = biz.rcept_no;
  }
  if (!rcept) throw new Error('사업보고서를 찾을 수 없습니다');
  // 2) 원문 zip → xml
  const zipBuf = await httpGetBuffer('opendart.fss.or.kr', `/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcept}`);
  const xml = unzipFirstXml(zipBuf);
  if (!xml) throw new Error('원문 압축 해제 실패');
  // 3) 평문화 + '사업의 개요' 섹션 발췌(최대 4500자)
  let txt = xml.replace(/<[^>]+>/g, ' ').replace(/&[a-zA-Z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  let i = txt.indexOf('사업의 개요');
  if (i < 0) i = txt.indexOf('사업의 내용');
  const section = i >= 0 ? txt.slice(i, i + 4500) : txt.slice(0, 4500);
  // 4) Gemini 요약
  const prompt = `당신은 친절한 기업분석 선생님입니다. 아래는 ${corpName}의 사업보고서 '사업의 개요' 원문입니다.\n` +
    `일반 투자자가 이해하기 쉽게 다음을 한국어로 정리해주세요(표 없이 서술형, 마크다운 소제목 사용):\n` +
    `1) 이 회사가 무엇을 하는지 핵심 사업 한 문단\n2) 사업부문(세그먼트) 구분과 각 부문이 뭘 만들고 파는지\n3) 매출 비중이 큰 부문/제품(원문에 수치 있으면 인용)\n4) 한 줄 핵심 요약\n\n원문:\n${section}`;
  const geminiRes = await callGemini(GEMINI_MODEL, prompt);
  if (geminiRes.error) throw new Error(geminiRes.error.message || 'Gemini 오류');
  let out = geminiRes.candidates?.[0]?.content?.parts?.[0]?.text || '요약 생성 실패';
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '');
  return { summary: out, rcept_no: rcept };
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

    // ── 재무 분기 시계열 (ver2.0 세부정보 탭 — 온디맨드·캐싱)
    if (pathname === '/api/financial-series') {
      const { corp_code, years, fs_div } = query;
      if (!corp_code) { res.writeHead(400); res.end(JSON.stringify({ status: 'ERR', message: 'corp_code 필수' })); return; }
      const yN = Math.min(Math.max(parseInt(years) || 3, 1), 6);   // 1~6년, 기본 3
      const fs = fs_div === 'OFS' ? 'OFS' : 'CFS';
      const cacheKey = `series|${corp_code}|${yN}|${fs}`;
      const hit = seriesGet(cacheKey);
      if (hit) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...hit, cached: true }));
        return;
      }
      const data = await fetchFinancialSeries(corp_code, yN, fs);
      seriesSet(cacheKey, data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...data, cached: false }));
      return;
    }

    // ── 밸류에이션 보조(주식수+배당) — 투자지표 탭 PER/PBR/EPS/DPS용
    if (pathname === '/api/valuation-extra') {
      const { corp_code, years } = query;
      if (!corp_code) { res.writeHead(400); res.end(JSON.stringify({ status: 'ERR', message: 'corp_code 필수' })); return; }
      const yN = Math.min(Math.max(parseInt(years) || 4, 1), 8);
      const cacheKey = `val|${corp_code}|${yN}`;
      const hit = genGet(valuationCache, cacheKey);
      if (hit) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ...hit, cached: true })); return; }
      const data = await fetchValuationExtra(corp_code, yN);
      genSet(valuationCache, cacheKey, data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...data, cached: false }));
      return;
    }

    // ── 직원현황 — 사업정보 탭
    if (pathname === '/api/employees') {
      const { corp_code, year } = query;
      if (!corp_code) { res.writeHead(400); res.end(JSON.stringify({ status: 'ERR', message: 'corp_code 필수' })); return; }
      const cacheKey = `emp|${corp_code}`;
      const hit = genGet(employeesCache, cacheKey);
      if (hit) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ...hit, cached: true })); return; }
      const data = await fetchEmployees(corp_code, parseInt(year) || null);
      genSet(employeesCache, cacheKey, data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...data, cached: false }));
      return;
    }

    // ── AI 사업요약(사업보고서 원문 → Gemini) — 온디맨드(버튼), 캐싱
    if (pathname === '/api/business-summary' && req.method === 'POST') {
      const bodyStr = await readBody(req);
      const { corpName, corpCode } = JSON.parse(bodyStr || '{}');
      if (!corpCode) { res.writeHead(400); res.end(JSON.stringify({ error: 'corpCode 필수' })); return; }
      const cacheKey = `biz|${corpCode}`;
      const hit = genGet(bizSummaryCache, cacheKey);
      if (hit) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ...hit, cached: true })); return; }
      try {
        const data = await fetchBusinessSummary(corpName || '', corpCode);
        genSet(bizSummaryCache, cacheKey, data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...data, cached: false }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
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
