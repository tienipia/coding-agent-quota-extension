# Coding Agent Quota

GNOME Shell extension that shows your **Claude Code** and **Codex** (OpenAI) token rate-limit usage right in the top panel — 5-hour and weekly windows, with accurate reset times.

[한국어](#한국어) · [English](#english)

---

## 한국어

### 무엇을 보여주나요

상단 패널:

```
[✦] 17%   [⊛] 17%
```

각 서비스 옆 숫자는 **5시간 / 주간** 윈도우 중 더 높은 사용률입니다. 색상은 50% 미만 초록, 50–80% 주황, 80% 이상 빨강. 인증 오류일 땐 `!`.

클릭하면 드롭다운에서 자세히:

```
✦ Claude Code                 cached 2m
  5 hours                          8.0%
  ████████░░░░░░░░░░░░
  resets 02:10 · in 3h 30m

  Weekly                           6.0%
  ██████░░░░░░░░░░░░░░
  resets 05-13 11:00 · in 4d 12h

⊛ Codex            snapshot 1m · prolite
  5 hours                         17.0%
  ██████████████████░░
  resets 02:17 · in 3h 40m
  …
  Refresh now
```

### 데이터 출처

- **Claude Code**: Anthropic의 `/api/oauth/usage` 엔드포인트 (Claude Code CLI가 자체적으로 `/usage` 표시할 때 쓰는 그 엔드포인트). **토큰을 소모하지 않습니다.** 응답을 15분 TTL로 로컬 캐시하고 만료 시 재요청.
- **Codex**: `~/.codex/sessions/**/*.jsonl` 의 가장 최근 `token_count` 이벤트에서 서버가 보낸 `rate_limits` 를 그대로 읽음. 별도 API 호출 없음.

`resets_at` 시각은 모두 서버가 직접 내려준 절대 시간이라 정확합니다.

### 요구사항

- GNOME Shell 45 ~ 49 (ESM imports, `Extension` 베이스 클래스)
- libsoup 3
- `~/.claude/.credentials.json` 의 OAuth 액세스 토큰 (Claude Code 한 번이라도 로그인되어 있으면 됨)
- Codex 사용량을 보려면 Codex CLI를 한 번이라도 실행해서 세션 JSONL이 있어야 함

### 설치

#### 방법 A — symbolic link (권장)

소스 디렉토리를 그대로 GNOME extensions 위치에 심볼릭 링크. 코드를 고치면 다음 셸 재시작에서 그대로 반영, pack/install 사이클 불필요.

```bash
git clone https://github.com/tienipia/coding-agent-quota-extension.git
cd coding-agent-quota-extension
ln -s "$PWD" \
      ~/.local/share/gnome-shell/extensions/coding-agent-quota@tienipia.github.io
```

> clone 위치는 자유. uuid가 들어가야 하는 곳은 **심볼릭 링크 이름**뿐.

#### 방법 B — zip pack 후 install (대안)

```bash
git clone https://github.com/tienipia/coding-agent-quota-extension.git
cd coding-agent-quota-extension
gnome-extensions pack . --force --out-dir=/tmp --extra-source=icons
gnome-extensions install --force /tmp/coding-agent-quota@tienipia.github.io.shell-extension.zip
```

#### 활성화

두 방법 모두 설치 후 **로그아웃 → 다시 로그인** (Wayland 제약 — 아래 참고). 그 다음:

```bash
gnome-extensions enable coding-agent-quota@tienipia.github.io
```

### 코드 변경 시 주의

GNOME Shell on Wayland는 보안상 **동작 중인 셸의 JS 모듈을 다시 로드하지 못합니다.** `disable && enable`을 해도 import 캐시는 유지되어요. 변경 사항을 반영하려면:

- 로그아웃 → 로그인 (가장 빠름)
- 또는 X11 세션에서 `Alt + F2 → r`
- 또는 개발 중이라면 `dbus-run-session -- gnome-shell --nested --wayland` 로 별도 창 띄우기

### Anthropic API 토큰 만료

`~/.claude/.credentials.json` 의 OAuth 토큰이 만료되면 패널에 `!` 가 뜹니다. 터미널에서 `claude` 한 번 실행하면 자동 갱신됩니다 (확장은 자동 refresh 안 함).

### 라이선스 / 로고

코드 자체는 **MIT**. `icons/claude-symbolic.svg` 와 `icons/codex-symbolic.svg` 는 각각 Anthropic, OpenAI 의 상표를 식별 목적으로 사용한 것입니다 (nominative use). 본 소프트웨어는 두 회사와 어떠한 관계도 없습니다.

---

## English

### What you see

Top panel:

```
[✦] 17%   [⊛] 17%
```

The number next to each service is the **worse of the 5-hour and weekly utilization**. Color is green under 50%, orange 50–80%, red 80%+. `!` shown on auth error.

Click for the full breakdown — see ASCII mock above. Each window row shows the utilization bar, exact reset timestamp, and countdown to reset.

### Where the data comes from

- **Claude Code**: Anthropic's `/api/oauth/usage` endpoint — the same one Claude Code's `/usage` view uses internally. **Does not consume tokens.** Cached locally with a 15-minute TTL; auto-refetched after expiry.
- **Codex**: the most recent `token_count` event in `~/.codex/sessions/**/*.jsonl`, where the server-pushed `rate_limits` block lives. No separate API call.

All `resets_at` values are absolute timestamps from the upstream server, so they're accurate.

### Requirements

- GNOME Shell 45 – 49 (ESM imports, `Extension` base class)
- libsoup 3
- An OAuth access token in `~/.claude/.credentials.json` (logging into Claude Code once is enough)
- For Codex usage, the Codex CLI must have been run at least once so that session JSONLs exist

### Install

#### Option A — Symbolic link (recommended)

Symlink the source tree directly into GNOME's extensions directory. Edits in the repo are picked up on the next shell restart — no pack/install cycle needed.

```bash
git clone https://github.com/tienipia/coding-agent-quota-extension.git
cd coding-agent-quota-extension
ln -s "$PWD" \
      ~/.local/share/gnome-shell/extensions/coding-agent-quota@tienipia.github.io
```

> Clone wherever you like. The uuid must match only on the **symlink name**.

#### Option B — Zip pack & install (alternative)

```bash
git clone https://github.com/tienipia/coding-agent-quota-extension.git
cd coding-agent-quota-extension
gnome-extensions pack . --force --out-dir=/tmp --extra-source=icons
gnome-extensions install --force /tmp/coding-agent-quota@tienipia.github.io.shell-extension.zip
```

#### Activate

For either method, after install **log out and log back in** (Wayland constraint, see below). Then:

```bash
gnome-extensions enable coding-agent-quota@tienipia.github.io
```

### After editing the code

GNOME Shell on Wayland **cannot reload an extension's JS while running** — the SpiderMonkey import cache survives `disable && enable`, `ReloadExtension` is deprecated, and `install --force` only overwrites disk files. To pick up changes:

- log out → log in (fastest)
- X11 session: `Alt + F2 → r`
- For iterative dev, run a nested shell in its own window: `dbus-run-session -- gnome-shell --nested --wayland`

### Anthropic token expiry

When the OAuth token in `~/.claude/.credentials.json` expires, the panel shows `!`. Run `claude` once in a terminal to refresh — the extension does not auto-refresh credentials.

### License & marks

Code is licensed under **MIT**. `icons/claude-symbolic.svg` and `icons/codex-symbolic.svg` reproduce the Anthropic and OpenAI marks respectively for nominative identification of those services. This project is not affiliated with or endorsed by either company.
