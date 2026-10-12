# AGENTS.md — 공통 작업 지침 (Codex · Claude Code 공용)

이 파일이 두 AI가 함께 따르는 원본이다. Claude Code는 `CLAUDE.md`에서 이 파일을 가져온다.
협업 절차 전체: [docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md)

## 프로젝트

대한민국 국가기술자격·국가전문자격 등의 필기·실기 시험일정을 모아 보여 주는 PWA(즐겨찾기 포함). 빌드 단계 없는 바닐라 JS 정적 웹앱이다.
Cloudflare Worker(`worker/`)가 공식 API와 기관 사이트 등 4곳에서 일정을 모아 KV에 캐시하고(매일 cron), 화면은 Worker의 `/api/schedules`를 읽는다.
운영: 웹 https://cert-schedule.pages.dev, Worker `cert-schedule-api`.

## 현재 상태 (2026-10-11 기준)

- 기본 브랜치 `main`(최초 커밋 1개). 열린 PR과 다른 브랜치는 없다.
- 데이터 소스·설계 결정·배포 절차는 인계 문서 [PROJECT_STATE.md](PROJECT_STATE.md)에 있다. 작업 전에 읽는다
  (특히 "데이터 단위에 대한 설계 결정").

## 구조

| 경로 | 역할 |
|---|---|
| `index.html`, `style.css`, `app.js` | 화면과 로직: 전체 일정·즐겨찾기·출처 탭, 등급·필기/실기 필터, 검색, 즐겨찾기(`localStorage`) |
| `sw.js` | 서비스워커(network-first, `CACHE`) |
| `manifest.json`, `icons/` | PWA 설정·아이콘 |
| `dist/` | 배포용 복사본. 루트 파일을 복사해 만들며 직접 고치지 않는다 |
| `worker/src/index.js` | Worker: 소스별 수집(`fetchHrdKorea`·`fetchDataq`·`fetchKca`·`fetchQnetCalendar`), KV 캐시, `/api/schedules`·`/api/refresh` |
| `worker/wrangler.toml` | Worker 설정: KV `SCHEDULES`, 매일 20:00 UTC cron |

## 명령

```sh
node --check app.js && node --check sw.js && node --check worker/src/index.js   # 문법 검사 (Node 22 이상)
rm -rf dist && mkdir dist && cp index.html style.css app.js manifest.json sw.js dist/ && cp -r icons dist/   # dist/ 다시 만들기
```

설치할 의존성은 없다(wrangler는 `npx`로 쓴다). 자동 테스트는 없다. 코드를 바꾼 PR은 문법 검사 통과가 필수다.
수집 파서를 바꿨으면 그 소스의 실제 페이지·응답과 결과를 대조한 내용을 PR에 남긴다.

## 보안·안전 정책

- 이 저장소는 public이다. `QNET_SERVICE_KEY`(공공데이터포털 서비스 키)는 Worker 시크릿으로만 둔다.
  코드·`wrangler.toml`·응답·`errors`·로그·PR·댓글에 넣지 않는다. `.wrangler/`(계정 ID·이메일)는 커밋하지 않는다.
- 시험 날짜가 틀리면 사용자가 시험을 놓친다. 소스가 직접 주는 단위(등급·회차)와 날짜만 보여 주고, 확인되지 않은
  종목명↔회차 연결을 하지 않는다. 출처 탭의 한계 고지를 지우거나 흐리지 않는다.
- 수집은 매일 한 번 cron으로 한다. 수집 대상 사이트를 더 자주 부르는 경로를 만들지 않는다.
  dataq.or.kr은 브라우저 자동화를 막으므로 plain `fetch()`로만 접근한다.
- 운영 Worker의 `/api/refresh`는 모든 소스를 다시 수집해 KV를 덮어쓰고 서비스 키의 호출 한도를 쓴다. 사용자 요청 없이 부르지 않는다.
- **알려진 위험(아직 고치지 않음)**. 아래 두 보호는 지금 코드에 없으므로 있는 것으로 가정하지 않는다.
  - `/api/refresh`에 인증이 없어 주소를 아는 누구나 부를 수 있다. 하루 한 번 수집과 서비스 키 한도는 지금 코드로 보장되지 않는다.
  - `refreshSchedules`는 소스가 실패해 결과가 비거나 크게 줄어도 KV를 그대로 덮어쓴다(`worker/src/index.js`의 `SCHEDULES.put`).
  - 고치려면 Worker 코드 변경과 배포가 필요하다(refresh 인증은 Worker 시크릿 등록도). 사용자가 정한 뒤 별도 PR로 한다.
- 즐겨찾기는 기기 `localStorage`에만 둔다. 서버로 보내지 않는다.
- 비밀값(API 키, 토큰, `~/.codex/auth.json`, `.env`)을 커밋·PR·댓글·로그에 남기지 않는다.

## 작업 규칙 (요약)

- `main`에 직접 push·병합하지 않는다. 한 작업 = 한 브랜치 = 한 PR. Claude는 `claude/<주제>`, Codex는 `codex/<주제>`.
- 작업 전 `git fetch`로 최신 상태를 받는다. 열린 PR이 바꾸는 파일은 조율 없이 수정하지 않는다.
- 다른 브랜치에 push·force-push·rebase 하지 않는다. 미커밋 변경을 덮어쓰지 않는다.
- 루트 파일(`index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icons/`)을 바꾸면 같은 PR에서 `dist/`를 다시 만든다.
  `sw.js`를 바꾸면 `CACHE` 버전을 올린다.
- 데이터 소스나 설계 결정이 바뀌면 같은 PR에서 PROJECT_STATE.md도 고친다.
- 병합은 사용자만 한다. 배포는 사용자가 요청할 때 병합된 `main`으로만 한다(절차: [docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md)).

## Codex 역할

구현 계획 검토, 코드 리뷰, 보안 취약점 검사, 테스트 결과 분석, 독립적으로 분리 가능한 기능 개발
(`codex/<주제>` 브랜치, 별도 PR). 지적에는 파일:줄, 심각도(P0~P3), 고칠 방법을 붙인다.

## Code Review Rules

- 확인되지 않은 종목명↔회차 연결(예: Q-Net 표의 회차와 API `implSeq` 매칭)처럼 시험 날짜를 다른 종목·회차에 붙일 수 있는
  변경은 P0. 안전한 경로: 소스가 직접 준 단위와 날짜만 쓰고 카드마다 원본 링크(`sourceUrl`)를 유지한다.
  출처 탭의 한계 고지를 지우거나 흐리면 P1.
- `QNET_SERVICE_KEY`가 코드·`wrangler.toml`에 들어가거나 응답·`errors`·KV에 실릴 수 있게 되면 P0. `errors`는 KV에 저장돼
  `/api/schedules`로 공개된다. 안전한 경로: `env.QNET_SERVICE_KEY`로만 읽고, 오류 메시지에 키가 든 URL을 넣지 않는다.
- 한 소스의 실패가 다른 소스를 막는 변경, 수집 결과가 KV를 덮어쓰는 조건을 더 느슨하게 하는 변경, 인증 없이 부를 수 있는
  수집·쓰기 경로를 새로 만드는 변경은 P1. 이전 캐시 보존과 `/api/refresh` 인증은 아직 코드에 없다(위 "알려진 위험").
  안전한 경로: 소스별 try/catch를 유지하고, 새 수집·쓰기 경로에는 인증과 "결과가 비거나 크게 줄면 이전 캐시를 그대로 두는" 확인을 넣는다.
- `sw.js`를 cache-first로 되돌리거나 `sw.js`를 바꾸면서 `CACHE`를 올리지 않으면 P1(설치된 사용자가 옛 화면에 갇힌다,
  2026-08-17에 고친 사고). 루트 파일을 바꾸고 `dist/`를 맞추지 않았으면 지적한다.
