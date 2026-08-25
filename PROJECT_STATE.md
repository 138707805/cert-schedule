# cert-schedule 프로젝트 현황 (2026-08-17 최신)

새 채팅방에서 이어서 작업할 때 이 파일을 먼저 읽어주세요.

## 이게 뭔지

대한민국 국가기술자격/국가전문자격 등의 등급별 회차 필기·실기 시험일정을 모아 보여주는 PWA. 즐겨찾기 기능 포함.

- 웹사이트: https://cert-schedule.pages.dev
- 로컬 경로: `/mnt/c/Users/user/Desktop/vs/cert-schedule`
- Worker(데이터 수집/캐시): https://cert-schedule-api.orbital-watch-push.workers.dev
- KV 네임스페이스: `SCHEDULES` (id: dcf12b1b59c540be92ab3a29b097f648)
- `QNET_SERVICE_KEY` Worker 시크릿 등록 완료.
- 매일 20:00 UTC cron으로 자동 재수집.

## ⚠️ 2026-08-17에 고친 심각한 버그: 서비스워커가 캐시를 영영 안 갱신하던 문제

`sw.js`의 `CACHE` 상수가 `cert-schedule-v1`에서 한 번도 안 바뀐 채로 `fetch` 핸들러가 **cache-first**(캐시에 있으면 무조건 캐시부터 응답)로 짜여 있었음. 브라우저는 `sw.js` 파일 자체가 바이트 단위로 안 바뀌면 새 서비스워커 설치 자체를 스킵하기 때문에, index.html/app.js/style.css를 여러 번 재배포해도 **사용자가 최초 방문했을 때의 스냅샷에 영원히 갇히는** 문제였음 — 즐겨찾기 탭/필기·실기 필터/원본 링크 같은 기능을 나중에 추가해도 이미 설치된 사용자 화면엔 전혀 반영이 안 됐던 것. "크롬에서 다운받았는데 안 열려요" + "필터 제대로 넣은거 맞아요?" 두 불만이 사실 같은 원인.

**고친 방법**: `CACHE`를 `cert-schedule-v2`로 올리고, fetch 전략을 **network-first**(온라인이면 항상 최신을 받아오고 캐시는 오프라인 폴백용으로만 갱신)로 바꿈. **앞으로 이런 문제가 재발하지 않도록, network-first 전략 자체가 구조적 해결책** — 이제부터는 `sw.js`를 다시 안 건드려도 index.html/app.js/style.css 재배포분이 항상 최신으로 반영됨. (다만 정말 sw.js 자체를 또 고칠 일이 생기면 그때는 CACHE 버전을 올려주는 습관을 유지할 것.)

**사용자에게 안내한 복구 방법**: 와이파이/데이터 켠 상태에서 앱을 한 번 다시 열면 자동으로 새 서비스워커가 설치되며 고쳐짐. 그래도 안 열리면 홈화면 아이콘 삭제 후 크롬에서 사이트 다시 열어 재설치 안내.

## UI 기능 (2026-08-17 기준 다 구현·모바일 터치 테스트까지 완료)

- **전체 일정 / 즐겨찾기 / 출처** 하단 탭 3개.
- **1차 필터 칩**: 전체 · 기능사 · 기능장 · 기사·산업기사 · 기술사(이상 T를 등급별로 쪼갠 것, `item.level` 필드 기준) · 국가전문자격 · 과정평가형 · 일학습병행 · 데이터자격(K-DATA) · 전파진흥원(KCA).
- **2차 필터 칩(필기/실기)**: 전체 단계 · 필기만 · 실기만 — 선택하면 그 단계 날짜만 남기고 "다음 일정"도 그 단계 기준으로 재계산(`getNextEvent(item, phaseFilter)`). `kind:'single'` 카드(Q-Net 캘린더발)는 필기/실기 구분이 없어 이 필터를 적용하면 자동으로 목록에서 빠짐.
- **검색창**: 자격증명/등급 텍스트 검색.
- **즐겨찾기**: `localStorage`에 카드 `id` 저장, 별표(☆/★) 탭으로 토글. 별표 탭 영역은 44px로 넓혀둠(2026-08-17, 터치 안 되는 문제 리포트 받고 수정 — 원래 아이콘 크기(~26px)만 눌렸었음).
- **카드마다 "이 일정의 원본 페이지 보기 ↗" 링크**: `item.sourceUrl`을 새 탭으로 엶. HRD Korea 항목은 등급별 Q-Net 탭(scheType)까지 맞춰서, Q-Net 캘린더 항목은 그 이벤트가 있는 정확한 월(`schMonth`)까지 맞춰서 링크됨.
- **지난 일정 보기/숨기기** 토글, D-day 표시.

## 데이터 소스 4개 (2026-08-17 기준 275건, 중복 제거 후)

1. **HRD Korea 공식 API** (data.go.kr, T/S/C/W) — 국가기술자격 등은 등급/회차 단위만.
2. **dataq.or.kr** (한국데이터산업진흥원/K-DATA) — 빅데이터분석기사, ADP/ADsP, SQLP/SQLD, DAP/DAsP. 정적 HTML 표 파싱, 종목명 명확.
3. **cq.or.kr** (한국방송통신전파진흥원/KCA) — 정보통신기술사, 전파전자통신기능사(수시), 무선통신사·아마추어무선기사(항공 포함). 정적 HTML 표 파싱. cq.or.kr의 "기능장·기사·산업기사·기능사" 표는 여러 종목이 한 회차에 섞여 있어(HRD Korea와 같은 이유) 의도적으로 제외함.
4. **Q-Net 국가전문자격 캘린더** (`crf021.do?id=crf02103&schMonth=YYYYMM01`) — 관세사/공인노무사/변리사 등 종목명이 `fn_openCalendar('google','제목','시작일','종료일')` 안에 그대로 박혀 있어 정확한 날짜로 추출 가능. `kind:'single'` 카드로 렌더링(필기/실기 그리드 없이 라벨+날짜 1줄). 국가기술자격(기사/기능사 등) 관련 항목은 1)과 중복이라 필터링해서 제외.

각 소스의 파서는 `worker/src/index.js`에 `fetchHrdKorea`/`fetchDataq`/`fetchKca`/`fetchQnetCalendar`로 분리되어 있고, 하나가 실패해도 나머지는 계속 진행됨(`refreshSchedules`의 try/catch).

**주의**: dataq.or.kr은 Playwright 같은 실제 브라우저(CDP 연결)로 접근하면 "개발자 도구 감지" 스크립트가 막아버림 — 반드시 plain `fetch()`(Worker의 fetch, 또는 Python urllib 등)로만 접근할 것. Q-Net 캘린더/cq.or.kr은 이런 차단이 없었음.

## ⚠️ 중요 — 데이터 단위에 대한 설계 결정 (다시 손대기 전에 꼭 읽을 것)

이 공식 API(`B490007/qualExamSchd/getQualExamSchdList`)는 **"정보처리기사" 같은 구체적 종목명을 주지 않는다.** 국가기술자격의 경우 기능사/기능장/기사·산업기사/기술사 **등급 단위** 회차 일정만 준다 (응답 필드: `description`, `docRegStartDt/docRegEndDt/docExamStartDt/docExamEndDt/docPassDt`, `pracRegStartDt/pracRegEndDt/pracExamStartDt/pracExamEndDt/pracPassDt`, `implSeq`).

Q-Net 홈페이지(`q-net.or.kr/crf021.do?scheType=01~04`)에는 종목명이 포함된 표가 따로 있어서, 이걸 Playwright로 긁어 종목명↔회차를 이어붙이는 걸 시도했었음. **폐기한 이유**: Q-Net UI의 "제N회" 번호가 이 API의 `implSeq`와 항상 일치하지 않음을 실제로 확인함 (예: `implSeq=1`에 서로 다른 날짜를 가진 중복 행이 3개 존재, UI가 보여주는 두 개 하위그룹 날짜와도 정확히 안 맞음). 시험 날짜를 잘못 매칭해서 특정 종목에 붙이면 사용자가 실제로 시험을 놓칠 수 있는 위험이라 — **확인 안 된 채로 join하지 않기로 결정**. 다시 이 방향을 시도하려면 Q-Net이 실제로 사용하는 내부 AJAX/JSON 엔드포인트를 브라우저 네트워크 탭에서 직접 찾아서 검증하거나, 종목코드(jmCd) 기준의 다른 공식 API(`한국산업인력공단_국가기술자격 종목별 시험정보`, data.go.kr id 15003029, `openapi.q-net.or.kr/api/service/rest/InquiryTestInformationNTQSVC/getPEList`)를 먼저 확인해볼 것 — 이건 종목별로 갈라진 6개 서비스(기술사/기능장/기사 등)라 가능성 있어 보이지만 이번 세션에선 시간상 검증 못 함.

**현재 앱은 이 한계를 출처 탭에 명시적으로 고지하고 있음** — "기능사 제107회는 언제"는 정확하지만 "정보처리기사가 몇 회인지"는 Q-Net 링크로 안내. 이 고지 문구를 지우거나 애매하게 하지 말 것.

## 데이터 범위 (출처 탭에 이미 고지되어 있음)

포함: 국가기술자격·국가전문자격·과정평가형·일학습병행 (한국산업인력공단/Q-Net 관장) — 등급/회차 단위.
미포함: 보건의료 국가시험(국시원), 변호사시험(법무부), 공인회계사(금감원) 등 타 기관 관장 자격증, 그리고 통합 일정 데이터가 없는 민간자격 전체.

## 배포 방법

### 웹사이트 배포
```bash
cd /mnt/c/Users/user/Desktop/vs/cert-schedule
rm -rf dist && mkdir dist && cp index.html style.css app.js manifest.json sw.js dist/ && cp -r icons dist/
npx wrangler pages deploy dist --project-name=cert-schedule
```

### Worker 배포
```bash
cd /mnt/c/Users/user/Desktop/vs/cert-schedule/worker
npx wrangler deploy
```

Worker는 매일 20:00 UTC(한국시간 새벽 5시)에 cron으로 자동 재수집됨 (`wrangler.toml`의 `[triggers]`).
