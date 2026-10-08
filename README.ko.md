<div align="center">

# Deckhand — Claude Code를 위한 멀티 AI 툴바

**Many hands, one deck.**

사용량 게이지, 원클릭 모델 전환, 병렬 서브 에이전트, 다른 AI CLI의 읽기 전용 세컨드 오피니언을 Claude Code 입력창 위 하나의 툴바에서 제공합니다.

[![Version](https://img.shields.io/badge/version-0.5.0-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.9-3C873A?style=flat-square)](#요구-사항)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](#설치)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

by [BetterWorkflows](https://github.com/stephen-taipei/better-workflows)

</div>

[설치](#설치) · [툴바 구성](#툴바-구성) · [위임 버튼](#위임-버튼) · [설정](#설정) · [추가 도구](#추가-도구) · [개인정보 보호 및 보안](#개인정보-보호-및-보안) · [변경 내역](CHANGELOG.md)

## Deckhand 소개

Deckhand는 Claude Code 플러그인입니다. 터미널과 데스크톱 앱의 입력창 위에 툴바를 추가합니다. Claude가 메인 에이전트 역할을 유지하며, 툴바에서 다음 작업을 수행할 수 있습니다.

- 각 사용량 윈도우의 잔여량 확인
- 클릭 한 번으로 모델 전환
- 별도의 git worktree에서 병렬 서브 에이전트로 작업 분할
- 다른 AI CLI에 읽기 전용으로 세컨드 오피니언을 요청하고 Claude가 검토
- 사이드 패널에서 현재 세션 진행 상황을 알기 쉬운 말로 요약 확인

## 설치

Claude Code에서 다음 두 명령어를 실행합니다.

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

입력창 위에 툴바가 표시됩니다. 표시되지 않으면 새 세션을 시작합니다.

## 툴바 구성

| 구성 요소 | 설명 |
| --- | --- |
| 사용량 게이지 | 5시간 윈도우, 모델별 주간 윈도우, 전체 모델 주간 윈도우, 컨텍스트 창 |
| `O` `F` `S` `H` | 모델을 Opus, Fable, Sonnet, Haiku로 전환 |
| `Sub5` | 현재 작업을 최대 5개 항목으로 분할하여 병렬 서브 에이전트로 실행 |
| `CL` `CS` `CA` `CR` `GF` | 다른 AI CLI에 읽기 전용으로 작업을 위임하고 Claude가 답변 검토 |
| `Recap` | 사이드 패널에서 현재 컨텍스트를 비유를 곁들여 알기 쉽게 설명 |
| `⚙` | 설정 패널 열기 (툴바 맨 오른쪽) |

버튼에 마우스를 올리면 기능 설명이 표시됩니다.

### 사용량 게이지

- `5h`: 5시간 윈도우입니다.
- 계정에서 제공하는 모델별 주간 윈도우 (예: Fable의 경우 `fb`).
- `7d`: 전체 모델 대상 주간 윈도우입니다.
- `ctx`: 컨텍스트 창 사용량입니다.

수치는 Claude 앱의 사용량 카드와 일치합니다(내림 표시). 윈도우가 경고 기준치를 넘으면 Deckhand가 토스트 알림을 한 번 표시합니다.

### 모델 버튼

`O` Opus · `F` Fable · `S` Sonnet · `H` Haiku

- **터미널:** 세션 모델을 바로 전환하며 effort 수준을 유지합니다.
- **데스크톱 앱:** 앱이 세션 모델을 관리합니다. 버튼을 누르면 입력창에 `/model <name>`이 입력됩니다. Enter 키를 누르면 앱 자체의 모델 메뉴와 동기화가 유지됩니다.

### Sub5

Sub5는 현재 작업을 최대 5개의 독립된 항목으로 분할합니다. 각 항목은 서로 다른 git worktree에서 서브 에이전트로 동시에 실행됩니다. 워커 에이전트 작업이 끝나면 메인 에이전트가 결과를 검토 및 통합하고, worktree와 브랜치를 정리합니다.

스크립트(`bin/sub5.py`)가 정확한 git 단계를 실행합니다. 강제 적용(force)이나 푸시(push)는 절대 수행하지 않습니다. 설정에서 워커 모델, effort, 최대 항목 수를 설정할 수 있습니다.

### 위임 버튼

위임 버튼은 다른 AI CLI에 하나의 작업을 맡깁니다. 해당 AI는 읽기 전용으로 작동하여 답변을 작성하고, Claude가 답변을 검토한 뒤 유효한 내용을 통합합니다.

| 버튼 | CLI | 모델 | Effort |
| --- | --- | --- | --- |
| `CL` | Codex | GPT-6 Luna | max |
| `CS` | Codex | GPT-6.1 Sol | medium |
| `CA` | Codex | GPT-6 Astra | medium |
| `CR` | Cursor agent | Grok 4.7 | high |
| `GF` | agy | Gemini 3.8 Flash | high |

위 값은 기본값입니다. 설정에서 라벨, CLI, 모델 ID, effort, 이름, 활성화 여부 등 각 대상을 수정할 수 있습니다.

- **CLI별 읽기 전용 처리:** Codex는 `-s read-only`, Cursor agent는 `--mode ask`로 실행되며, agy는 헤드리스로 실행되어 도구 호출이 자동으로 차단됩니다.
- **시크릿 검사:** 토큰, 키 또는 비밀번호가 포함된 요청 내용은 위임을 거부합니다.
- **로컬 기록 관리:** 요청 내용과 답변은 비공개 임시 폴더에 보관되며 3일 후 삭제됩니다.
- **요구 사항:** 해당 CLI가 설치되어 있고 로그인되어 있어야 합니다. 설치되지 않은 CLI 버튼은 자동으로 숨겨집니다.

> [!NOTE]
> 위임 기능을 사용하면 해당 CLI를 제공하는 서비스 제공업체로 요청 내용이 전송됩니다.

### Recap

Recap은 사이드 패널에서 현재 컨텍스트 전체를 비유를 곁들여 최대한 명확하고 간결하게 설명합니다. 대화 기록에는 아무것도 추가하지 않습니다. 버튼 라벨은 표시 언어를 따릅니다. 영어는 `Recap`, 번체 중국어는 `通靈`으로 표시됩니다.

### 설정

툴바 맨 오른쪽의 `⚙` 버튼을 누르면 설정 패널이 열립니다. 다음 항목을 수정할 수 있습니다.

- 표시 언어
- 표시할 버튼
- 위임 대상
- Sub5 모델, effort, 최대 항목 수
- CLI 경로 및 Codex 홈 폴더
- 작성자 표기 가드
- 폴링 가드 및 중단 횟수
- 사용량 경고 기준치
- 번역 모델

설정은 사용자별로 저장됩니다.

### 지원 언어

English, 繁體中文, 简体中文, 日本語, 한국어를 지원합니다. 기본값으로 Claude Code의 `language` 설정을 따르며, 설정 패널에서 직접 언어를 선택할 수도 있습니다.

## 추가 도구

| 도구 | 설명 |
| --- | --- |
| `/watch-deploy` 및 `watch_deploy` 도구 | PR, CI 실행 또는 URL을 백그라운드에서 감시합니다. 연속해서 N회 동일한 결과가 나오면 감시를 자동으로 중단합니다. |
| `/handoff`, `/handoff-in`, `/codex` | Claude와 Codex 간에 작업을 전달합니다. Codex용 인수인계 작성, Codex의 최신 인수인계 내용을 입력창으로 불러오기, Codex 받은 편지함 열기를 지원합니다. |
| 작성자 표기 가드 | 커밋 및 PR 명령어에서 `Co-Authored-By` 트레일러와 Claude Code 바닥글을 제거합니다. Claude 설정에서 이미 작성자 표기가 꺼져 있지 않은 한 기본값은 꺼짐입니다. |
| 폴링 가드 | `sleep` 폴링 루프와 `gh run watch` 같은 블로킹 대기를 막고, 같은 결과가 연속 N회 나온 상태 확인을 중단합니다. |
| `agy_translate` | 직역 대신 원어민 개발자가 실제로 사용하는 표현으로 agy를 통해 로컬라이즈 번역을 수행합니다. |

## 요구 사항

- 플러그인 훅 모듈을 지원하는 Claude Code (2.1.288 버전에서 테스트됨).
- Python 3.9 이상.
- 선택 사항: 감시 기능을 위한 `gh`, 위임 버튼을 위한 `codex`, Cursor `agent`, `agy` CLI.

## 개인정보 보호 및 보안

사용자의 컴퓨터 밖으로 전송되는 데이터:

- **위임 요청 내용**은 위임 버튼을 눌렀을 때만 선택한 CLI 제공업체로 전송됩니다.
- **사용량 조회**는 Claude Code를 통해 현재 세션의 인증 정보로 Anthropic의 사용량 엔드포인트를 호출합니다.
- **사용자 또는 Claude가 직접 호출한 도구**는 해당 서비스와 통신합니다. `agy_translate`는 agy를 통해 텍스트를 전송하고, 감시 도구는 `gh`를 통해 GitHub를 조회하거나 지정한 URL을 호출합니다.

그 밖의 데이터는 컴퓨터 밖으로 전송되지 않습니다.

보안 규칙:

- 위임 작업은 각 CLI 자체 플래그나 모드를 통해 읽기 전용으로 강제 적용됩니다.
- 시크릿 검사를 통해 토큰, 키 또는 비밀번호가 포함된 요청 내용은 전송을 거부합니다.
- 요청 내용과 답변은 비공개 임시 폴더에 보관되며 3일 후 자동으로 정리됩니다.
- Sub5의 git 스크립트는 강제 적용(force)이나 푸시(push)를 절대 수행하지 않습니다.

## 개발

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
```

`scripts/scan-secrets.py`는 Git이 추적하는 모든 파일에서 키, 토큰, URL 내 자격 증명, 이메일 주소, 홈 폴더 경로를 검사합니다. 자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

## 기여, 보안 및 라이선스

[기여 가이드](CONTRIBUTING.md) · [보안 정책](SECURITY.md) · [변경 내역](CHANGELOG.md) · [라이선스](LICENSE)

[BetterWorkflows](https://github.com/stephen-taipei/better-workflows)가 제작하고 [stephen-taipei](https://github.com/stephen-taipei)가 유지 관리합니다. Deckhand는 독립 플러그인이며 Anthropic 제품이 아닙니다. [MIT 라이선스](LICENSE)로 배포됩니다.
