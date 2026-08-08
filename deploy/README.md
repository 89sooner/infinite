# 사내 서버 배포

systemd 호스트에 `infinite`를 서비스로 올립니다. 프로젝트마다 인스턴스를 하나씩 띄우는
템플릿 유닛 방식입니다.

```
deploy/
  install.sh           설치 스크립트 (root로 실행)
  infinite@.service    템플릿 유닛 (install.sh가 렌더링)
```

## 설치

```bash
git clone https://github.com/89sooner/infinite.git
cd infinite

sudo deploy/install.sh --dry-run --project acme-api   # 계획만 출력
sudo deploy/install.sh --project acme-api             # 실제 설치
```

`--dry-run`은 **아무것도 바꾸지 않고** 실행될 명령을 셸 이스케이프된 형태로 출력합니다.
낯선 서버에서는 먼저 이걸로 확인하세요.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--prefix` | `/opt/infinite` | 코드 설치 위치 |
| `--projects` | `/srv/infinite` | 프로젝트 디렉터리들의 부모 |
| `--config` | `/etc/infinite` | env 파일 위치 |
| `--user` | `infinite` | 서비스 계정 |
| `--project <이름>` | — | 프로젝트까지 스캐폴딩 |
| `--no-create-user` | — | 계정이 이미 있다고 가정 |
| `--dry-run` | — | 계획만 출력 |

설치 스크립트가 하는 일:

1. Node 22.18 이상 확인 (TypeScript를 빌드 없이 실행하므로 이 버전이 하한입니다)
2. 서비스 계정 생성 — **홈 디렉터리 있는 시스템 계정**. Claude Code가 자격 증명과
   트랜스크립트를 홈에 두고 npm도 캐시를 거기 두기 때문입니다
3. 코드를 `--prefix`로 복사 (`.git`, `node_modules`, 로컬 상태 제외) 후 `npm ci --omit=dev`
4. `/etc/infinite/default.env` 생성 (`0640 root:infinite`)
5. 유닛 렌더링 후 `/etc/systemd/system/infinite@.service`에 설치
6. `--project`를 줬으면 `infinite init` 실행

**시작은 하지 않습니다.** 미션과 정책을 검토한 뒤 직접 켜야 합니다.

## 설치 후 해야 할 것

### 1. 인증

두 방법 중 하나. 서비스 계정으로 한 번만 하면 됩니다.

```bash
sudo -u infinite -H claude auth        # 대화형 로그인
```

또는 `/etc/infinite/default.env`에 `ANTHROPIC_API_KEY=`를 넣습니다.

### 2. 대시보드 토큰

`default.env`의 `INFINITE_TOKEN`이 `change-me`로 들어갑니다. **반드시 바꾸세요.**
없으면 바인딩 주소에 닿을 수 있는 누구나 API를 호출할 수 있습니다.

### 3. 미션과 도구 정책

```bash
sudoedit /srv/infinite/acme-api/MISSION.md
sudoedit /srv/infinite/acme-api/infinite.config.json
```

`toolPolicy.allowBash`를 이 프로젝트의 빌드·테스트 명령까지 넓혀야 합니다. 기본 목록은
일반적인 것만 담고 있습니다.

### 4. 시작

```bash
sudo systemctl enable --now infinite@acme-api
journalctl -u infinite@acme-api -f
```

**첫 실행은 제한을 걸어두세요.** 프로젝트 설정에서 `maxLegs: 3`, `maxCostUsdTotal: 5`로
두고 `/srv/infinite/acme-api/.infinite/handoffs/`의 문서 품질을 직접 확인한 뒤 풀어주는
편이 안전합니다.

## 여러 프로젝트

템플릿 유닛이라 파일을 복제할 필요가 없습니다.

```bash
sudo deploy/install.sh --project billing
sudo systemctl enable --now infinite@billing
```

인스턴스 이름이 `/srv/infinite/` 아래 디렉터리 이름입니다. 설정 우선순위는
`/etc/infinite/default.env` → `/etc/infinite/<이름>.env` 순이고, 뒤가 앞을 덮습니다.

포트가 겹치므로 대시보드를 여러 개 띄울 때는 각 프로젝트의 `<이름>.env`에
`INFINITE_PORT`를 다르게 주세요.

## 운영

| 하고 싶은 것 | 명령 |
|---|---|
| 상태 | `systemctl status infinite@acme-api` |
| 로그 추적 | `journalctl -u infinite@acme-api -f` |
| 현재 진행 | `sudo -u infinite node /opt/infinite/src/cli.ts status --cwd /srv/infinite/acme-api` |
| 핸드오프 읽기 | `sudo -u infinite node /opt/infinite/src/cli.ts handoff 3 --cwd /srv/infinite/acme-api` |
| 알림 테스트 | `sudo -u infinite node /opt/infinite/src/cli.ts notify-test --cwd /srv/infinite/acme-api` |
| 정상 중단 | `systemctl stop infinite@acme-api` |

### 중단이 즉시 끝나지 않습니다

`SIGTERM`은 **현재 턴이 끝난 뒤** 반영됩니다. 턴 하나가 몇 분 걸릴 수 있어
`TimeoutStopSec=900`으로 잡아뒀습니다. 이보다 짧게 잡으면 systemd가 턴 중간에 `SIGKILL`을
보내고, 그 턴의 작업은 핸드오프 없이 사라집니다.

상태는 `.infinite/state.json`에 원자적으로 저장되므로 재시작하면 마지막 세션 다음부터
이어집니다.

### 재시작 정책

```ini
Restart=on-failure          # 미션 완료(exit 0)는 재시작하지 않음
RestartSec=30
StartLimitIntervalSec=1h    # 구조적으로 깨진 미션이 무한 재시작하는 것을 막음
StartLimitBurst=5
```

미션이 `COMPLETE`로 끝나면 유닛은 멈춘 채로 남습니다. 정상 동작입니다.

## 업그레이드

```bash
cd ~/infinite && git pull
sudo deploy/install.sh                      # --project 없이: 코드만 갱신
sudo systemctl restart infinite@acme-api
```

설치 스크립트는 `MISSION.md`, `infinite.config.json`, `.infinite/`, 그리고 이미 존재하는
env 파일을 건드리지 않습니다.

> `rsync`가 있으면 삭제된 파일까지 정리하는 클린 업그레이드가 됩니다. 없으면 `tar`로
> 복사하며, 이전 버전에만 있던 파일이 남습니다(스크립트가 경고합니다). 최소 설치
> 이미지에서는 `rsync`를 먼저 넣는 편이 좋습니다.

## 보안

유닛에 적용된 것:

- 전용 비특권 계정 — **root로는 Claude Code가 무인 권한 모드를 거부합니다**
- `ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, `CapabilityBoundingSet=`(전부 제거),
  커널/cgroup/시계 보호, 네임스페이스·realtime·SUID 제한
- 쓰기 허용은 프로젝트 디렉터리와 서비스 계정 홈뿐

`ProtectHome`은 **의도적으로 끕니다.** Claude Code의 자격 증명과 트랜스크립트가 홈에
있고 npm 캐시도 거기 있어서, 켜면 동작하지 않습니다.

대시보드는 `127.0.0.1`에 바인딩됩니다. 원격 접근이 필요하면 **리버스 프록시 + TLS**를
앞에 두세요. 유닛을 고쳐 `--host 0.0.0.0`으로 바꾸는 것은 권하지 않습니다.

자격 증명은 `/etc/infinite/*.env`에만 둡니다. `infinite.config.json`은 커밋되는 파일이고,
`${VAR}` 문법으로 env를 참조합니다 — 참조한 변수가 없으면 시작 자체가 실패합니다.

## 비용

세션을 갈아엎을 때마다 프롬프트 캐시가 무효화되어 새 세션의 첫 턴이 비쌉니다(대략 3~4만
토큰의 캐시 생성). 실측 기준으로 4턴 실행이 sonnet에서 약 $3.7이었습니다.

`maxCostUsdTotal`을 반드시 걸어두세요. 무인 실행에서 이게 유일한 지출 상한입니다.
