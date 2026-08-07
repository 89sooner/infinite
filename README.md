# infinite

하나의 미션을 **무제한 개수의 Claude Code 세션에 걸쳐** 이어서 수행하는 데몬입니다.

세션의 컨텍스트가 임계값(기본 80%)에 도달하면 자동으로 핸드오프 문서를 쓰게 하고, 세션을
끝내고, 빈 컨텍스트의 새 세션이 그 문서만 읽고 작업을 이어받습니다. 사람의 개입은 없습니다.

```
세션 1  ──80%──▶  핸드오프 작성  ──▶  종료
                                      │
세션 2  ◀── 핸드오프 주입 ────────────┘  ──80%──▶  핸드오프 작성  ──▶  종료
                                                                      │
세션 3  ◀───────────────────────────────────────────────────────────┘  ...
```

---

## 왜 필요한가

Claude Code에는 이미 auto-compact가 있습니다. 하지만 compact는 **같은 세션 안에서** 과거
대화를 요약으로 대체하는 방식이라, 요약의 요약이 쌓이면서 드리프트가 누적됩니다.

`infinite`는 대신 세션을 완전히 갈아엎습니다. 넘어가는 것은 두 가지뿐입니다.

- **MISSION.md** — 매 세션에 **원문 그대로** 주입됩니다. 절대 요약되지 않으므로 목표가 흐려지지 않습니다.
- **핸드오프 문서** — 직전 세션이 남긴 진행 상황. 구조가 고정되어 있습니다.

그리고 Claude Code 순정 기능만으로는 이걸 만들 수 없습니다. 훅(hook)은 파일을 쓸 수는 있어도
`/clear`를 하거나 새 세션을 시작시킬 수 없기 때문입니다. 세션 경계를 넘는 제어는 반드시
바깥에서 와야 하고, 이 도구가 그 바깥입니다.

---

## 요구사항

- **Node.js 22.18 이상** — TypeScript를 그대로 실행하므로 빌드 단계가 없습니다
- 인증된 Claude Code (`claude auth`) 또는 `ANTHROPIC_API_KEY`
- **non-root 사용자** — `bypassPermissions`는 root에서 거부됩니다 (아래 [보안](#보안) 참조)

## 설치

```bash
git clone https://github.com/89sooner/infinite.git
cd infinite
npm install
```

## 빠른 시작

```bash
# 1. 작업할 프로젝트에서 초기화
node /path/to/infinite/src/cli.ts init --cwd ~/work/my-project

# 2. MISSION.md 를 채운다  ← 이 도구의 품질은 여기서 8할이 결정됩니다

# 3. 실행
node /path/to/infinite/src/cli.ts run --cwd ~/work/my-project --server
```

대시보드는 `http://127.0.0.1:4319` 에 열립니다.

---

## MISSION.md 쓰는 법

미션은 매 세션에 원문 그대로 들어가는 **유일한 불변 텍스트**입니다. 짧고 안정적으로 유지하세요.

```markdown
# Mission

## Goal
단계가 아니라 결과를 쓸 것. 끝났을 때 무엇이 참인가?

## Definition of done
- [ ] 검증 가능한 구체적 조건
- [ ] 또 하나

## Constraints
- 건드리면 안 되는 파일/디렉터리/시스템
- 절대 실행하면 안 되는 명령
- 스스로 결정하지 말고 물어봐야 하는 것

## Notes
코드 위치, 테스트 실행법, 담당자 등 시작에 필요한 맥락.
```

**Definition of done을 검증 가능하게 쓰세요.** 에이전트는 이 기준으로 `COMPLETE`를 판단하고,
`COMPLETE`가 나오면 실행이 종료됩니다.

---

## 핸드오프 문서

임계값에 도달하면 에이전트는 여섯 개의 고정 섹션으로 문서를 씁니다.

| 섹션 | 역할 |
|---|---|
| `STATE` | 지금 무엇이 참인가. 각 항목을 **VERIFIED**(직접 실행해 확인) / **ASSUMED**(추정)로 표시 |
| `NEXT STEPS` | 순서가 있고 실행 가능한 다음 단계. 파일·명령·함수 이름을 명시 |
| `FACTS AND DECISIONS` | 경로, 동작하는 명령, 버전, API 형태, 내린 결정과 그 이유 |
| `DEAD ENDS` | 시도했지만 실패한 접근과 이유 — **다음 세션이 같은 실패를 반복하는 것을 막습니다** |
| `OPEN QUESTIONS` | 막힌 지점과 이를 풀 방법 |
| `FILES` | 생성·수정한 파일 목록 |

`DEAD ENDS`가 이 구조의 핵심입니다. 이게 없으면 새 세션은 매번 같은 벽에 부딪힙니다.

문서는 `.infinite/handoffs/leg-NNN.md`에 저장되고, 다음 세션에는 **직전 한 개**와 전체 세션의
**한 줄 요약 로그**가 함께 들어갑니다 — 최근 맥락은 깊게, 장기 맥락은 싸게 유지하는 구조입니다.

에이전트가 문서 쓰기에 실패해도 마지막 응답을 회수해 저장하므로 세션이 통째로 유실되지는 않습니다.

---

## 세션 프로토콜

에이전트는 매 응답을 상태 줄로 끝냅니다.

```
INFINITE_STATUS: CONTINUE              # 계속 진행
INFINITE_STATUS: COMPLETE              # 미션 전체 완료 → 실행 종료
INFINITE_STATUS: BLOCKED: <이유>        # 사람의 판단 필요
```

`BLOCKED`는 기본적으로 경고만 남기고 계속 진행합니다. 즉시 멈추려면 `stopOnBlocked: true`.

---

## 설정

`infinite.config.json` (CLI 플래그와 환경변수가 이 파일을 덮어씁니다):

| 키 | 기본값 | 설명 |
|---|---|---|
| `missionFile` | `MISSION.md` | 미션 파일 경로 |
| `handoffThreshold` | `0.8` | 핸드오프를 트리거하는 컨텍스트 비율 (0-1). 0.92 초과는 거부됩니다 |
| `maxLegs` | `0` | 최대 세션 수. 0은 무제한 |
| `maxTurnsPerLeg` | `0` | 이 턴 수에 도달하면 컨텍스트와 무관하게 핸드오프. 0은 비활성 |
| `maxCostUsdPerLeg` | `0` | 세션당 지출 상한 도달 시 핸드오프. 0은 비활성 |
| `maxCostUsdTotal` | `0` | 전체 지출 상한 도달 시 실행 중단. 0은 비활성 |
| `legCooldownSec` | `5` | 다음 세션 시작 전 대기 |
| `model` | `null` | 모델 지정 (예: `"opus"`) |
| `effort` | `null` | `low`/`medium`/`high`/`xhigh`/`max` |
| `permissionMode` | `"default"` | `default`면 아래 도구 정책을 사용 |
| `toolPolicy` | 내장 허용목록 | 무인 실행용 도구 승인 규칙 |
| `disableAutoCompact` | `false` | Claude Code 자체 compact 비활성화 |
| `stopOnBlocked` | `false` | `BLOCKED` 보고 시 실행 중단 |
| `idleNudge` | 내장 문구 | 큐가 비었을 때 보낼 메시지 |
| `server` | `{...}` | 대시보드 설정 |

환경변수: `INFINITE_THRESHOLD`, `INFINITE_PORT`, `INFINITE_TOKEN`, `INFINITE_MODEL`

### CLI

```
infinite run [옵션]        실행 (또는 이어서 실행)
infinite status            현재 상태 출력
infinite init              설정 파일과 MISSION.md 생성
infinite handoff <n>       n번 세션의 핸드오프 출력

  --cwd <dir>            에이전트 작업 디렉터리
  --threshold <0-1>      핸드오프 임계값
  --model <name>         모델
  --max-legs <n>         최대 세션 수
  --max-cost <usd>       전체 지출 상한
  --server               대시보드 실행
  --port / --host        대시보드 바인딩
  --bypass-permissions   도구 정책 대신 모든 도구 승인
  --no-auto-compact      Claude Code 자체 compact 비활성화
  --quiet                stdout 로그 억제
```

---

## 대시보드

`--server`를 붙이면 의존성 없는 단일 페이지가 뜹니다.

- 임계값 마커가 표시된 **실시간 컨텍스트 게이지**
- 세션별 결과 / 턴 수 / 컨텍스트 / 비용 / 한 줄 요약
- **핸드오프 뷰어** — 세션 간에 실제로 무엇이 넘어갔는지 확인
- **지시 큐** — 실행 중에 지시를 넣으면 현재 턴이 끝난 뒤 전달됩니다
- 일시정지 / 지금 핸드오프 / 중단 버튼
- SSE 실시간 이벤트 로그

`server.token`(또는 `INFINITE_TOKEN`)을 설정하면 모든 API에 Bearer 토큰이 필요합니다.
브라우저는 `?token=...`으로 접근합니다. 기본 바인딩은 `127.0.0.1`이며, 원격 접근은
**리버스 프록시 + TLS**를 쓰세요.

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/state` | 상태 스냅샷 |
| `GET` | `/api/events` | SSE 스트림 (`history`, `state`, `log`) |
| `GET` | `/api/handoff/:n` | 핸드오프 원문 |
| `POST` | `/api/tasks` | `{"text": "..."}` 지시 추가 |
| `POST` | `/api/control` | `{"action": "pause"\|"resume"\|"handoff"\|"stop"}` |

---

## 보안

무인 실행은 권한 프롬프트에 답할 수 없습니다. 두 가지 선택지가 있습니다.

**1. 도구 정책 (기본, 권장)** — `permissionMode: "default"`일 때 명시적 허용목록으로 판단합니다.

- `allowTools` — 무조건 허용할 도구
- `allowBash` — 허용할 명령 접두사. 복합 명령은 `&&`, `||`, `;`, `|`, 줄바꿈으로 분해해
  **모든 조각이 각각 통과해야** 허용됩니다. `git status && rm -rf /etc`는 차단됩니다
- `denyBash` — 우선 검사되는 금지 패턴
- `fallback` — 어디에도 안 걸렸을 때. 기본 `"deny"`

거부는 도구 에러로 전달되므로 에이전트는 멈추지 않고 우회하거나 `OPEN QUESTIONS`에 기록합니다.

**2. `--bypass-permissions`** — 전부 승인. 격리된 컨테이너에서만 쓰세요.
**root에서는 Claude Code가 거부하므로 전용 non-root 계정이 필요합니다.**

미션 파일과 핸드오프는 모델에 그대로 들어갑니다. **자격 증명을 넣지 마세요.**

---

## 서버 운영

```ini
# /etc/systemd/system/infinite.service
[Unit]
Description=infinite — relayed Claude Code agent
After=network-online.target

[Service]
Type=simple
User=infinite
WorkingDirectory=/srv/projects/my-project
Environment=INFINITE_TOKEN=change-me
ExecStart=/usr/bin/node /opt/infinite/src/cli.ts run --server --host 127.0.0.1
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

`SIGTERM`/`SIGINT`은 현재 턴이 끝난 뒤 정상 종료합니다(한 번 더 보내면 강제 종료).
상태는 `.infinite/state.json`에 원자적으로 저장되므로 재시작하면 마지막 세션 다음부터 이어집니다.

**비용 주의:** 세션을 갈아엎을 때마다 프롬프트 캐시가 무효화되어 새 세션의 첫 턴이
비쌉니다(대략 3~4만 토큰의 캐시 생성). 임계값을 너무 낮게 잡으면 이 비용이 누적됩니다.
`maxCostUsdTotal`로 상한을 걸어두세요.

---

## 동작 원리

컨텍스트 사용량은 Agent SDK의 `query.getContextUsage()`로 매 턴 직접 읽습니다 —
JSONL 트랜스크립트를 파싱하지 않으므로 내부 포맷 변경에 영향받지 않습니다.

```
totalTokens / maxTokens ≥ handoffThreshold  →  핸드오프 프롬프트 주입
```

한 세션(leg)의 수명:

1. 미션 + 직전 핸드오프 + 진행 로그 + 대기 중인 지시로 스트리밍 세션 시작
2. 턴이 끝날 때마다 `getContextUsage()` 확인
3. 임계값 도달 → 핸드오프 프롬프트 전송 → 다음 응답을 기다린 뒤 세션 종료
4. 문서를 `.infinite/handoffs/`에 저장, 한 줄 요약 추출
5. 새 세션에서 반복

`disableAutoCompact`를 켜지 않으면 Claude Code의 compact가 안전망으로 남습니다.
compact가 임계값보다 먼저 발동하면 경고를 남기므로 로그에서 바로 확인할 수 있습니다.

### 상태 파일

```
.infinite/
  state.json            세션·비용·큐·컨텍스트 (원자적 쓰기)
  events.jsonl          감사 로그
  handoffs/
    leg-001.md
    leg-002.md
```

---

## 알려진 한계

- **핸드오프는 손실 압축입니다.** 문서에 없는 것은 사라집니다. 미션의 `Constraints`가
  중요한 이유입니다 — 그것만은 매번 원문으로 다시 들어갑니다.
- **컨텍스트를 즉시 100% 채우는 단일 도구 호출**은 임계값 검사를 건너뛸 수 있습니다.
  이 경우 Claude Code의 auto-compact가 안전망으로 동작합니다.
- **연속 2회 세션 실패 시 실행이 중단됩니다** — 일시적 오류가 아니라 구조적 문제로 보고
  무한 재시도 루프를 막습니다.
- 컨텍스트를 읽지 못한 턴은 임계값 검사를 건너뜁니다(경고가 기록됩니다).

## 라이선스

MIT
