# 파일럿 운영 런북

## 최초 준비

1. 128비트 이상 무작위 `PILOT_SLUG`를 생성합니다.
2. 법제처 공동활용에서 자치법규 OPEN API용 `OC`를 발급받습니다.
3. 병무청 실데이터 수집 사용 조건을 확인하기 전에는 `MMA_LIVE_INGESTION_ENABLED=false`를 유지합니다.
4. `EmailOtpEnabled=false`로 1차 배포합니다. 이 단계에서는 Cognito가 SES를 사용하지 않고 비밀번호 인증만 허용합니다.
5. `SesFromEmail`로 도착한 SES 발신 identity 검증 메일과 소유자 및 모든 파일럿 사용자의 sandbox 수신자 검증 메일을 각각 클릭합니다.
6. SES 콘솔에서 발신 identity와 모든 sandbox 수신자의 상태가 검증 완료인지 확인합니다.
7. 1차 배포의 `AmplifyBranchUrl`과 `HttpApiEndpoint`를 확인하고 Kakao Developers 앱에 Amplify 호스트를 등록합니다.
8. `EmailOtpEnabled=true`, `CorsAllowedOrigin=<AmplifyBranchUrl>`, `PublicApiBaseUrl=<HttpApiEndpoint>`로 2차 배포합니다. 이 단계부터 Cognito 이메일 OTP가 활성화됩니다.

## 기존 수동 Amplify 앱을 GitHub에 연결

이미 수동 모드로 배포된 Amplify 앱은 아래 두 번의 CloudFormation 업데이트로 전환합니다. 두 단계를 한 번에 합치지 않고, 두 업데이트 모두에서 여기 적지 않은 기존 파라미터 값을 그대로 유지합니다.

먼저 현재 `AmplifyAppId`, 브랜치 이름, `HttpApiEndpoint`, CORS origin과 안전 스위치 값을 기록하고 인프라 typecheck·test·synth를 통과시킵니다. PAT는 Git에 무시되는 로컬 비밀 파일에만 두고, 비밀값을 가리는 배포 도구가 파일에서 읽게 합니다. 셸 추적을 켜거나, 파라미터·하위 프로세스 인자·오류 메시지에 PAT를 출력해서는 안 됩니다. 이 런북에는 PAT가 포함되는 원시 CLI 명령을 남기지 않습니다.

| 업데이트 | `AmplifyBranchEnabled` | `GitHubRepository` | `GitHubAccessToken` |
| --- | --- | --- | --- |
| 1단계 — 수동 브랜치 제거 | `false` | 빈 값 | 빈 값 |
| 2단계 — GitHub 연결·브랜치 재생성 | `true` | 정확한 HTTPS 저장소 URL | 로컬 비밀 파일에서 읽은 PAT |

1. 1단계 파라미터로 배포하고 스택이 `UPDATE_COMPLETE`가 될 때까지 기다립니다.
2. 기존 `AmplifyAppId`가 그대로이고 대상 브랜치만 삭제됐는지 확인합니다. 이 단계에서는 `AmplifyBranchUrl`과 `PilotUrl` 출력이 의도적으로 사라지고 파일럿 사이트도 일시적으로 사용할 수 없습니다.
3. 2단계에서 GitHub 저장소와 토큰을 반드시 함께 전달해 배포합니다. 둘 중 하나만 있으면 CloudFormation 규칙이 리소스 변경 전에 배포를 거부합니다.
4. 스택이 `UPDATE_COMPLETE`가 된 뒤 앱의 repository, 브랜치 이름, `enableAutoBuild=true`를 확인합니다.
5. 브랜치 생성만으로 build job이 생기지 않으면 `list-jobs`로 0건임을 확인한 뒤, 권한 있는 운영 경로에서 `RELEASE`를 시작하거나 검증된 정상 변경을 PR로 `main`에 병합해 최초 자동 빌드를 트리거합니다. 빌드만을 위한 직접 `main` push는 하지 않습니다.
6. Amplify 빌드가 `SUCCEED`인지 확인하고 복원된 `PilotUrl`에서 404 루트, 비공개 slug 화면, API 호출을 스모크 테스트합니다. 스택 업데이트 성공만으로 전환 완료로 판단하지 않습니다.

BuildSpec, CustomHeaders, 환경변수처럼 Amplify App 설정과 소스가 함께 바뀌는 경우에는 CDK 업데이트를 먼저 완료하고 실제 App 설정 반영을 확인한 뒤 소스 PR을 병합합니다. 순서가 뒤집히면 GitHub webhook이 이전 App 설정으로 자동 빌드를 시작합니다. 운영자에게 `amplify:StartJob` 권한이 없으면 권한을 임시 확대하지 않고, 검증된 정상 변경 PR을 병합해 다음 빌드를 시작합니다.

7. 확인이 끝나면 로컬 토큰 파일을 삭제하고 단기 PAT를 폐기합니다.

1단계가 롤백되면 CloudFormation이 기존 수동 브랜치를 복원합니다. 2단계가 롤백되면 브랜치가 없는 1단계 상태로 돌아가므로 연결 문제를 고친 뒤 2단계를 다시 실행합니다. 전환을 포기할 때는 GitHub 파라미터를 둘 다 빈 값으로 두고 `AmplifyBranchEnabled=true`로 수동 브랜치를 다시 만든 다음 정적 산출물을 수동 배포합니다.

## 게시 안전 가드

- 초기 배포에서는 `PUBLISH_ENABLED=false`를 유지합니다. 값이 누락되거나 `true`가 아니면 게시 API는 부작용 없이 503을 반환합니다.
- Amplify 배포 성공을 확인한 뒤에만 변경을 `PUBLISHED`로 전환하고 알림을 보내는 성공 게이트가 구현·검증되기 전에는 이 값을 `true`로 바꾸지 않습니다.
- Amplify BuildSpec은 웹 단위 테스트, 정적 빌드, 404 및 파일럿 slug HTML 존재 검사를 수행합니다. 이는 빌드 산출물 smoke gate이며 실제 배포 활성화와 브라우저 동작 성공을 증명하지는 않습니다.
- 모노레포 사용자 지정 헤더는 CDK `CustomHeaders`를 단일 원천으로 사용하고 `applications -> appRoot -> customHeaders` 형식을 유지합니다. `appRoot`와 `AMPLIFY_MONOREPO_APP_ROOT`는 모두 `apps/web`이어야 하며, 별도 `customHttp.yml`은 추가하지 않습니다.
- 가드가 비활성인 동안에도 수집과 소유자 검수는 계속할 수 있으며 승인된 변경은 게시 대기 상태로 남습니다.

## 일상 운영

- 시설·공지 수집은 매일, 조례 수집은 매주 실행됩니다.
- 수집 실패 알람이 오면 Lambda 로그와 DLQ를 확인합니다.
- `PENDING` 변경의 원문과 전후 내용을 확인한 뒤 승인 또는 거절합니다.
- 할인율·대상·증빙·유효기간 변경은 전화번호 변경과 함께 묶여 있어도 수동 검수합니다.
- 게시 후 파일럿 URL에서 검색, 상세 원문, 마지막 확인일을 점검합니다.

## 롤백

1. Amplify 빌드가 실패하면 새 배포는 활성화되지 않으므로 직전 성공 배포를 그대로 유지합니다.
2. 데이터 자체를 되돌려야 하면 S3 Versioning에서 `published/manifest.json`의 직전 정상 version ID를 확인합니다.
3. 해당 버전을 현재 `published/manifest.json`으로 복사한 뒤 Amplify `RELEASE` 작업을 다시 시작합니다.
4. 파일럿 URL의 manifest와 index SHA-256, 검색·상세 화면을 확인합니다.
5. 문제 변경은 원천을 재수집하기 전까지 승인하지 않고 원인을 운영 메모에 기록합니다.

현재 파일럿 관리자 화면은 검수·승인·게시 시작을 지원하며, S3 버전 선택 롤백은 소유자가 AWS 콘솔 또는 CLI에서 수행합니다.

## 비용 이상

### 비용 할당 태그 활성화

1. 최초 배포 예산은 현재 활성화된 `Environment=pilot` 태그로 필터링됩니다.
2. 최초 배포 후 Billing and Cost Management의 **Cost allocation tags**에서
   `Application` 키가 나타날 때까지 확인합니다. 새 태그 키가 표시되는 데 최대
   24시간이 걸릴 수 있습니다.
3. 사용자 정의 `Application` 태그를 활성화하고 상태가 `Active`가 될 때까지
   기다립니다. 활성화에도 최대 24시간이 걸릴 수 있습니다.
4. 활성화 후 예산 필터를 `Application=honor-benefits`까지 좁힙니다. 기존
   `CostFilters.TagKeyValue`에 서로 다른 태그 키 값을 단순히 함께 넣으면 결합
   의미가 명확하지 않으므로, 적용 전 AWS Budgets의 생성 결과를 확인하고
   필요하면 `FilterExpression`의 명시적 `And`로 전환합니다.
5. 비용 태그가 활성화되기 전에는 필터링된 예산 사용액이 0으로 보일 수 있습니다.

- 월 1만 원 경고: Amplify 빌드 횟수와 CloudWatch 로그량을 확인합니다.
- 월 3만 원 경고: 스케줄을 일시 중지하고 API 호출·배포 반복 여부를 조사합니다.
- 비용 원인을 찾을 때까지 실데이터 수동 재실행과 반복 배포를 중단합니다.

## 공개 전환 체크

- 초대 기반 전체 로그인과 사용자 약관
- 사용자 도메인, WAF, 강화된 API 제한
- dev/prod 계정 분리와 정식 SES production access
- 병무청 자동수집·재사용 확인
- 개인정보·위치정보 법률 검토
- 접근성 수동 검사와 실제 단말 푸시 검증
