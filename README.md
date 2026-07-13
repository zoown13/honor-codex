# 병역명문가 혜택찾기

병역명문가 우대시설, 전국 혜택, 지자체 조례를 한곳에서 찾고 변경 알림을 받을 수 있는 10명 미만 비공개 파일럿입니다.

> 이 프로젝트는 병무청 공식 서비스가 아닙니다. 혜택을 이용하기 전 반드시 각 상세 화면의 공식 원문과 문의처에서 최신 조건을 확인하세요.

## 파일럿 원칙

- 조회 화면은 로그인 없이 긴 공유 링크로 접근합니다. 공유 링크는 접근통제가 아니므로 공개 공공데이터만 노출합니다.
- 현재 위치는 브라우저 안에서 거리 계산에만 사용하며 AWS API나 로그로 보내지 않습니다.
- 팔로우와 알림을 신청할 때만 이메일 OTP로 주소를 확인합니다.
- 병무청 실데이터 수집은 `MMA_LIVE_INGESTION_ENABLED=true`일 때만 동작합니다.
- 할인율, 대상, 증빙, 유효기간, 삭제·종료 변경은 관리자 승인 전까지 게시하지 않습니다.

## 구조

```text
apps/web              Next.js 정적 PWA
packages/core         공통 타입·검색·수집·변경 판정
services/functions    Lambda/API/스케줄 작업
infra                 AWS CDK 파일럿 스택
docs                  운영·데이터 정책 문서
```

## 로컬 실행

필요 조건은 Node.js 24와 pnpm 11입니다.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

`.env.local`에서 최소한 `NEXT_PUBLIC_PILOT_SLUG`를 32자리 이상의 무작위 16진수로 바꿉니다. Kakao 지도 키가 없으면 앱은 접근 가능한 목록 모드로 정상 동작합니다.

## 검증

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm cdk:synth
```

실제 브라우저 E2E는 Playwright 브라우저가 준비된 환경에서 `pnpm test:e2e`로 실행합니다.

## AWS 배포

1. AWS CLI 프로필에서 대상 계정과 `ap-northeast-2` 리전을 확인합니다.
2. `pnpm cdk:synth`로 리소스를 검토합니다.
3. 최초 계정이면 `pnpm --filter @honor/infra bootstrap`을 실행합니다.
4. `pnpm --filter @honor/infra deploy`로 파일럿 스택을 배포합니다.
5. 출력된 Amplify URL·API URL로 2차 배포를 실행하고 파일럿 사용자 이메일을 SES sandbox에서 검증합니다.

세부 절차는 [운영 런북](docs/RUNBOOK.md)을 참고하세요.

## 데이터 출처

- [병무청 병역명문가 예우시설 검색](https://www.mma.go.kr/hall/listsearch.do?mc=mma0003390)
- [병무청 공개개방포털 이용약관](https://open.mma.go.kr/caisGGGS/contents/html/view.do?menu_id=mma0000033)
- [법제처 자치법규 OPEN API](https://open.law.go.kr/LSO/openApi/guideResult.do?htmlName=ordinListGuide)

자동수집·재사용 조건은 공개 확대 전에 각 제공기관과 반드시 확인해야 합니다.
