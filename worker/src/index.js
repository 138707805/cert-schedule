// 자격증 시험일정 API 프록시 + 캐시용 Cloudflare Worker
//
// 데이터 소스 4개:
// 1) 공공데이터포털 - 한국산업인력공단_국가자격 시험일정 조회 서비스 (data.go.kr/data/15074408)
//    국가기술자격/국가전문자격/과정평가형/일학습병행. ⚠️ 등급/회차 단위만 제공, 종목명 없음
//    (이유는 아래 fetchHrdKorea 주석 참고).
// 2) 한국데이터산업진흥원 데이터자격시험 (dataq.or.kr) - ADsP/SQLD 등 6개 종목, 정적 HTML 표.
// 3) 한국방송통신전파진흥원 KCA 국가기술자격검정 (cq.or.kr) - 정보통신기술사/전파전자통신기능사/
//    무선통신사/아마추어무선기사, 정적 HTML 표. (전파전자통신 분야 기능장·기사·산업기사·기능사는
//    여러 종목이 한 회차에 섞여 있어 종목명 매칭이 애매해 제외함 - 아래 이유와 동일)
// 4) Q-Net 전문자격 일정 캘린더(crf021.do?id=crf02103) - 월별 캘린더에 종목명+정확한 날짜가
//    직접 박혀 있어(fn_openCalendar 호출부) 관세사/공인노무사/변리사 등 국가전문자격 개별
//    종목명을 안전하게 가져올 수 있음. 국가기술자격(기사/기능사 등) 관련 항목은 이미 1)에서
//    등급 단위로 다루고 있어 중복을 피하려고 여기서는 걸러냄.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/schedules") {
      const cached = await env.SCHEDULES.get("schedules", "json");
      if (!cached) {
        return json({ items: [], updatedAt: null, note: "아직 데이터가 수집되지 않았습니다." });
      }
      return json(cached);
    }

    if (url.pathname === "/api/refresh") {
      const result = await refreshSchedules(env);
      return json(result);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshSchedules(env));
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

async function refreshSchedules(env) {
  const errors = [];
  let items = [];

  try {
    const r = await fetchHrdKorea(env);
    items = items.concat(r.items);
    errors.push(...r.errors);
  } catch (e) {
    errors.push({ source: "hrdkorea", msg: String(e) });
  }

  try {
    items = items.concat(await fetchDataq());
  } catch (e) {
    errors.push({ source: "dataq", msg: String(e) });
  }

  try {
    items = items.concat(await fetchKca());
  } catch (e) {
    errors.push({ source: "kca", msg: String(e) });
  }

  try {
    items = items.concat(await fetchQnetCalendar());
  } catch (e) {
    errors.push({ source: "qnetCalendar", msg: String(e) });
  }

  // 원본 API가 동일 회차를 중복 행으로 내려주는 경우가 있어 id 기준으로 정리
  const dedupedItems = [...new Map(items.map((it) => [it.id, it])).values()];

  const payload = {
    items: dedupedItems,
    updatedAt: new Date().toISOString(),
    errors,
    sources: [
      {
        name: "공공데이터포털 - 한국산업인력공단_국가자격 시험일정 조회 서비스",
        url: "https://www.data.go.kr/data/15074408/openapi.do",
        provider: "한국산업인력공단 (Q-Net)",
      },
      {
        name: "데이터자격시험 시험일정",
        url: "https://www.dataq.or.kr/www/accept/schedule.do",
        provider: "한국데이터산업진흥원 (K-DATA)",
      },
      {
        name: "KCA 국가기술자격검정 연간시험일정",
        url: "https://www.cq.or.kr/qh_quagm03_001.do",
        provider: "한국방송통신전파진흥원 (KCA)",
      },
      {
        name: "국가전문자격 일정안내(캘린더)",
        url: "https://www.q-net.or.kr/crf021.do?id=crf02103",
        provider: "한국산업인력공단 (Q-Net)",
      },
    ],
  };

  await env.SCHEDULES.put("schedules", JSON.stringify(payload));
  return { ok: true, count: dedupedItems.length, errors };
}

function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ===================================================================
// 1) 한국산업인력공단(HRD Korea) 공식 API
// ⚠️ 이 API는 "정보처리기사" 같은 개별 종목명이 아니라, 자격구분(국가기술자격/
// 국가전문자격/과정평가형/일학습병행) x 등급 x 회차 단위의 원서접수/시험일/발표일만
// 제공한다. Q-Net 홈페이지의 종목별 표를 긁어 이 API의 implSeq와 이어붙이는 것도
// 시도했으나, 회차 번호 체계가 정확히 일치하지 않는 사례(중복 implSeq에 서로 다른
// 날짜가 붙는 등)를 실제로 확인해서 폐기했다. 시험 날짜 오매칭은 사용자가 실제로
// 시험을 놓칠 수 있는 위험이라, 확인 안 된 채로 특정 종목에 날짜를 붙이지 않는다.
// ===================================================================
const HRD_UPSTREAM = "https://apis.data.go.kr/B490007/qualExamSchd/getQualExamSchdList";
const QUALGB_CODES = ["T", "S", "C", "W"];
const QUALGB_LABEL = { T: "국가기술자격", S: "국가전문자격", C: "과정평가형", W: "일학습병행" };

async function fetchHrdKorea(env) {
  const serviceKey = env.QNET_SERVICE_KEY;
  const errors = [];
  const items = [];
  if (!serviceKey) {
    errors.push({ source: "hrdkorea", msg: "QNET_SERVICE_KEY 시크릿이 설정되지 않았습니다." });
    return { items, errors };
  }

  const now = new Date();
  const years = [now.getFullYear(), now.getFullYear() + 1];

  for (const year of years) {
    for (const qualgbCd of QUALGB_CODES) {
      let pageNo = 1;
      const numOfRows = 50; // 이 API의 페이지당 최대 조회 수
      while (true) {
        const params = new URLSearchParams({
          serviceKey,
          numOfRows: String(numOfRows),
          pageNo: String(pageNo),
          dataFormat: "json",
          implYy: String(year),
          qualgbCd,
        });
        const res = await fetch(`${HRD_UPSTREAM}?${params.toString()}`);
        const data = await res.json().catch(() => null);

        if (data?.header && data.header.resultCode !== "00") {
          errors.push({ source: "hrdkorea", year, qualgbCd, pageNo, msg: data.header.resultMsg });
          break;
        }

        const body = data?.body;
        const rows = Array.isArray(body?.items) ? body.items : [];
        if (rows.length === 0) break;

        for (const raw of rows) items.push(mapHrdItem(raw, year, qualgbCd));

        const totalCount = Number(body?.totalCount || 0);
        if (pageNo * numOfRows >= totalCount) break;
        pageNo += 1;
        if (pageNo > 20) break; // 안전장치
      }
    }
  }
  return { items, errors };
}

// T(국가기술자격)에는 기능사/기능장/기사/기술사 4개 등급이 섞여 있다.
// (참고: 이 API에서 "기사"는 산업기사를 포함한 값 - Q-Net도 "기사,산업기사"를 한 탭에서 같이 다룸)
const LEVEL_LABEL = { 기능사: "기능사", 기능장: "기능장", 기사: "기사·산업기사", 기술사: "기술사" };
// Q-Net 연간 국가기술자격 시험일정 페이지의 등급별 탭 코드 (scheType)
const LEVEL_SCHETYPE = { 기술사: "01", 기능장: "02", 기사: "03", 기능사: "04" };

function extractLevel(description) {
  const m = (description || "").match(/국가기술자격\s+(기능사|기능장|기사|기술사)/);
  return m ? m[1] : null;
}

function mapHrdItem(raw, year, qualgbCd) {
  const examStartForId = raw.docExamStartDt || raw.pracExamStartDt || "";
  const level = qualgbCd === "T" ? extractLevel(raw.description) : null;
  const sourceUrl =
    qualgbCd === "T" && level
      ? `https://www.q-net.or.kr/crf021.do?id=crf02101&scheType=${LEVEL_SCHETYPE[level]}`
      : "https://www.q-net.or.kr/crf021.do?id=crf02103"; // S/C/W: 전문자격 등 일정안내
  return {
    id: `hrd-${qualgbCd}-${year}-${raw.implSeq}-${examStartForId}`,
    name: raw.description || `${QUALGB_LABEL[qualgbCd]} ${year}년 제${raw.implSeq}회`,
    qualgbCd,
    qualgbNm: level ? LEVEL_LABEL[level] : QUALGB_LABEL[qualgbCd],
    level,
    sourceUrl,
    kind: "wp",
    written: {
      applyStart: toIsoDate(raw.docRegStartDt),
      applyEnd: toIsoDate(raw.docRegEndDt),
      examStart: toIsoDate(raw.docExamStartDt),
      examEnd: toIsoDate(raw.docExamEndDt),
      result: toIsoDate(raw.docPassDt),
    },
    practical: {
      applyStart: toIsoDate(raw.pracRegStartDt),
      applyEnd: toIsoDate(raw.pracRegEndDt),
      examStart: toIsoDate(raw.pracExamStartDt),
      examEnd: toIsoDate(raw.pracExamEndDt),
      result: toIsoDate(raw.pracPassDt),
    },
  };
}

// ===================================================================
// 공통 HTML 표 파서 (rowspan 지원, 정적 HTML 전용 - JS 렌더링 필요 없는 페이지만 사용)
// ===================================================================
function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// tableHtml(<table>...</table>) -> 행 배열 (각 행은 numCols 길이의 문자열 배열), rowspan/colspan 적용
function parseTableRows(tableHtml, numCols) {
  const rows = [];
  const tbodyRe = /<tbody[^>]*>([\s\S]*?)<\/tbody>/g;
  let tbodyMatch;
  const bodies = [];
  while ((tbodyMatch = tbodyRe.exec(tableHtml))) bodies.push(tbodyMatch[1]);
  if (bodies.length === 0) bodies.push(tableHtml); // tbody 없는 경우 전체에서 tr 탐색

  for (const bodyHtml of bodies) {
    const pending = {};
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let trMatch;
    while ((trMatch = trRe.exec(bodyHtml))) {
      const trHtml = trMatch[1];
      const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRe.exec(trHtml))) {
        const attrs = cellMatch[1];
        const text = stripTags(cellMatch[2]);
        const rs = parseInt((attrs.match(/rowspan="(\d+)"/) || [, "1"])[1], 10);
        const cs = parseInt((attrs.match(/colspan="(\d+)"/) || [, "1"])[1], 10);
        cells.push({ text, rs, cs });
      }
      if (cells.length === 0) continue;
      const resultRow = {};
      let c = 0,
        idx = 0;
      while (c < numCols) {
        if (pending[c] && pending[c].remaining > 0) {
          resultRow[c] = pending[c].text;
          pending[c].remaining -= 1;
          c += 1;
          continue;
        }
        if (idx < cells.length) {
          const cell = cells[idx++];
          for (let k = 0; k < cell.cs; k++) {
            resultRow[c + k] = cell.text;
            if (cell.rs > 1) pending[c + k] = { text: cell.text, remaining: cell.rs - 1 };
          }
          c += cell.cs;
        } else {
          c += 1;
        }
      }
      const arr = [];
      for (let i = 0; i < numCols; i++) arr.push(resultRow[i] || "");
      rows.push(arr);
    }
  }
  return rows;
}

// "3.3~9", "4.4(토)", "3.30~4.3" 같은 월.일 표기를 그 해 ISO 날짜 [시작,끝]으로 변환
function parseKoreanDateRange(s, year) {
  if (!s || s === "-") return [null, null];
  const cleaned = s.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
  const parts = cleaned.split("~").filter(Boolean);
  if (parts.length === 0) return [null, null];

  const toDate = (token, prevMonth) => {
    let m = token.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) return { mo: parseInt(m[1], 10), da: parseInt(m[2], 10) };
    m = token.match(/^(\d{1,2})$/);
    if (m && prevMonth) return { mo: prevMonth, da: parseInt(m[1], 10) };
    return null;
  };

  const first = toDate(parts[0], null);
  if (!first) return [null, null];
  const startIso = `${year}-${String(first.mo).padStart(2, "0")}-${String(first.da).padStart(2, "0")}`;

  if (parts.length === 1) return [startIso, startIso];

  const second = toDate(parts[1], first.mo);
  if (!second) return [startIso, startIso];
  const endYear = second.mo < first.mo ? year + 1 : year; // 12월->1월 걸치는 경우
  const endIso = `${endYear}-${String(second.mo).padStart(2, "0")}-${String(second.da).padStart(2, "0")}`;
  return [startIso, endIso];
}

// ===================================================================
// 2) 한국데이터산업진흥원 데이터자격시험 (dataq.or.kr) - 정적 HTML 표
// ===================================================================
async function fetchDataq() {
  const res = await fetch("https://www.dataq.or.kr/www/accept/schedule.do", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const html = await res.text();

  const yearMatch = html.match(/(\d{4})년\s*국가공인/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  const tab0Idx = html.indexOf('id="tab0"');
  const tableIdx = html.indexOf("table_schdule_all", tab0Idx);
  const tableStart = html.lastIndexOf("<table", tableIdx);
  const tableEnd = html.indexOf("</table>", tableIdx) + "</table>".length;
  const tableHtml = html.slice(tableStart, tableEnd);

  const rows = parseTableRows(tableHtml, 9);
  // 컬럼: [자격명, 회차, 필기/실기구분, 원서접수, 수험표발급, 시험일, 사전점수공개, 합격발표, 서류제출]
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    const [name, round, subtype, apply, , examDay, , result] = r;
    if (!name || !round) continue;
    const key = `${name}|${round}|${subtype}|${apply}|${examDay}`;
    if (seen.has(key)) continue; // 원본 HTML의 중복 tr 방지
    seen.add(key);

    const [applyStart, applyEnd] = parseKoreanDateRange(apply, year);
    const [examStart, examEnd] = parseKoreanDateRange(examDay, year);
    const [resultStart] = parseKoreanDateRange(result === "-" ? "" : result, year);

    items.push({ name, round, subtype, applyStart, applyEnd, examStart, examEnd, result: resultStart });
  }

  // 같은 (name, round) 안에서 필기/실기를 하나의 카드로 합치기
  const grouped = new Map();
  for (const it of items) {
    const key = `${it.name}|${it.round}`;
    if (!grouped.has(key)) grouped.set(key, { name: it.name, round: it.round, written: null, practical: null });
    const g = grouped.get(key);
    const slot = { applyStart: it.applyStart, applyEnd: it.applyEnd, examStart: it.examStart, examEnd: it.examEnd, result: it.result };
    if (it.subtype === "필기") g.written = slot;
    else if (it.subtype === "실기") g.practical = slot;
    else g.written = slot; // 필기/실기 구분 없는 단일 시험(ADsP, SQLD 등)
  }

  const empty = { applyStart: null, applyEnd: null, examStart: null, examEnd: null, result: null };
  return [...grouped.values()].map((g) => ({
    id: `dataq-${g.name}-${g.round}`,
    name: `${g.name} ${g.round}`,
    qualgbCd: "DATA",
    qualgbNm: "데이터자격(K-DATA)",
    sourceUrl: "https://www.dataq.or.kr/www/accept/schedule.do",
    kind: "wp",
    written: g.written || empty,
    practical: g.practical || empty,
  }));
}

// ===================================================================
// 3) 한국방송통신전파진흥원 KCA 국가기술자격검정 (cq.or.kr) - 정적 HTML 표
// (전파전자통신 분야 기능장·기사·산업기사·기능사 표는 여러 종목이 한 회차에
//  섞여 있어 종목명이 애매해져서 제외 - HRD Korea 쪽과 같은 이유)
// ===================================================================
async function fetchKca() {
  const res = await fetch("https://www.cq.or.kr/qh_quagm03_001.do", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const html = await res.text();
  const year = new Date().getFullYear();

  const tables = [];
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) tables.push(m[0]);

  const items = [];

  // table[0]: 정보통신기술사 - [회별,필기접수,필기시험,필기발표,서류제출(skip),면접접수,면접시험,합격발표]
  if (tables[0]) {
    const rows = parseTableRows(tables[0], 8);
    for (const [round, wApply, wExam, wResult, , pApply, pExam, pResult] of rows) {
      if (!round || !round.startsWith("제")) continue;
      items.push(buildKcaItem("정보통신기술사", round, year, wApply, wExam, wResult, pApply, pExam, pResult));
    }
  }

  // table[2]: 전파전자통신기능사 수시검정 - [회별,필기접수,필기시험,필기발표,실기접수,실기시험,합격발표]
  if (tables[2]) {
    const rows = parseTableRows(tables[2], 7);
    for (const [round, wApply, wExam, wResult, pApply, pExam, pResult] of rows) {
      if (!round || !round.startsWith("제")) continue;
      items.push(buildKcaItem("전파전자통신기능사(수시)", round, year, wApply, wExam, wResult, pApply, pExam, pResult));
    }
  }

  // table[4]: 무선통신사·아마추어무선기사 6종목(항공제외) - [회차,접수,시험,발표]
  if (tables[4]) {
    const rows = parseTableRows(tables[4], 4);
    for (const [round, apply, exam, result] of rows) {
      if (!round) continue;
      items.push(buildKcaItem("무선통신사·아마추어무선기사(6종목,항공제외)", `제${round}회`, year, apply, exam, result, "", "", ""));
    }
  }

  // table[5]: 항공무선통신사 - rowspan 회차 + [필기/실기구분,접수,시험,발표]
  if (tables[5]) {
    const rows = parseTableRows(tables[5], 5);
    const grouped = new Map();
    for (const [round, subtype, apply, exam, result] of rows) {
      if (!round) continue;
      if (!grouped.has(round)) grouped.set(round, {});
      const [applyStart, applyEnd] = parseKoreanDateRange(apply, year);
      const [examStart, examEnd] = parseKoreanDateRange(exam, year);
      const [resultStart] = parseKoreanDateRange(result, year);
      grouped.get(round)[subtype] = { applyStart, applyEnd, examStart, examEnd, result: resultStart };
    }
    const empty = { applyStart: null, applyEnd: null, examStart: null, examEnd: null, result: null };
    for (const [round, g] of grouped) {
      items.push({
        id: `kca-항공무선통신사-제${round}회`,
        name: `항공무선통신사 제${round}회`,
        qualgbCd: "KCA",
        qualgbNm: "전파진흥원(KCA)",
        sourceUrl: "https://www.cq.or.kr/qh_quagm03_001.do",
        kind: "wp",
        written: g["필기"] || empty,
        practical: g["실기"] || empty,
      });
    }
  }

  return items;
}

function buildKcaItem(name, round, year, wApply, wExam, wResult, pApply, pExam, pResult) {
  const [wApplyStart, wApplyEnd] = parseKoreanDateRange(wApply, year);
  const [wExamStart, wExamEnd] = parseKoreanDateRange(wExam, year);
  const [wResultStart] = parseKoreanDateRange(wResult, year);
  const [pApplyStart, pApplyEnd] = parseKoreanDateRange(pApply, year);
  const [pExamStart, pExamEnd] = parseKoreanDateRange(pExam, year);
  const [pResultStart] = parseKoreanDateRange(pResult, year);
  return {
    id: `kca-${name}-${round}`,
    name: `${name} ${round}`,
    qualgbCd: "KCA",
    qualgbNm: "전파진흥원(KCA)",
    sourceUrl: "https://www.cq.or.kr/qh_quagm03_001.do",
    kind: "wp",
    written: { applyStart: wApplyStart, applyEnd: wApplyEnd, examStart: wExamStart, examEnd: wExamEnd, result: wResultStart },
    practical: { applyStart: pApplyStart, applyEnd: pApplyEnd, examStart: pExamStart, examEnd: pExamEnd, result: pResultStart },
  };
}

// ===================================================================
// 4) Q-Net 국가전문자격 일정 캘린더 (crf021.do?id=crf02103) - 월별 정적 HTML
// fn_openCalendar('google','제목','시작일YYYYMMDD','종료일YYYYMMDD') 호출부에
// 종목명+정확한 날짜가 그대로 들어있어 이걸 그대로 추출한다 (날짜 오매칭 위험 없음).
// 국가기술자격(기사/기능사/기능장/기술사/산업기사) 등급 단위 항목은 1)에서 이미
// 다루므로 중복을 피하려고 여기서는 제외한다.
// ===================================================================
const GENERIC_LEVEL_PREFIXES = ["기사", "기능사", "기능장", "기술사", "산업기사"];

async function fetchQnetCalendar() {
  const now = new Date();
  const months = [];
  // 이번 달부터 12개월 (해 넘어가는 부분 포함)
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`);
  }

  const items = [];
  const seen = new Set();

  for (const ym of months) {
    const res = await fetch(
      `https://www.q-net.or.kr/crf021.do?id=crf02103&gSite=Q&gId=&schGb=list&schMonth=${ym}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const html = await res.text();
    const re = /fn_openCalendar\('google','([^']*)','(\d{8})','(\d{8})'\)/g;
    let m;
    while ((m = re.exec(html))) {
      const rawTitles = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      const start = m[2];
      const end = m[3];
      for (const title of rawTitles) {
        const withoutRound = title.replace(/^제\d+회\s*/, "");
        const isGenericLevel = GENERIC_LEVEL_PREFIXES.some((p) => withoutRound.startsWith(p));
        if (isGenericLevel) continue; // 등급 단위 항목은 1)에서 이미 커버

        const key = `${title}|${start}|${end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({
          id: `qnetcal-${key}`,
          name: title,
          qualgbCd: "S",
          qualgbNm: "국가전문자격",
          sourceUrl: `https://www.q-net.or.kr/crf021.do?id=crf02103&gSite=Q&gId=&schGb=list&schMonth=${ym}`,
          kind: "single",
          dateStart: toIsoDate(start),
          dateEnd: toIsoDate(end),
        });
      }
    }
  }
  return items;
}
