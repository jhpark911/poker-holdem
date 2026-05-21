# Texas Hold'em — 개발 기록

## 프로젝트 개요

Node.js + Express + Socket.io 기반의 멀티플레이어 텍사스 홀덤 포커 게임.  
친구들이 방 코드로 입장하여 실시간으로 함께 플레이할 수 있으며, 봇도 추가 가능.

**주요 기술 스택**
- Backend: Node.js, Express, Socket.io
- Frontend: Vanilla JS, CSS
- 패 판정: pokersolver 라이브러리
- 배포: Render.com (https://github.com/jhpark911/poker-holdem)

---

## 현재 구현된 기능 목록

### 로비
- 닉네임 + 방 코드로 입장 (방 코드 없으면 신규 방 생성)
- 방 코드 대문자 자동 변환
- 마스터 관리자 패널 (🔑 관리자 버튼, 비밀번호 인증 후 전체 방 목록 조회 및 삭제)

### 게임 설정 (방장 전용)
- SB / BB 금액 조정
- 시작 칩 수량 설정
- 리바이 금액 설정
- 행동 타이머 (0~120초, 0이면 타이머 비활성화)

### 테이블
- 최대 9명 착석 (타원형 테이블)
- **인원수에 따라 균등 배치**: N명이면 360°/N 간격으로 자동 분산 (2명=6·12시, 4명=6·3·12·9시 등)
- 커뮤니티 카드 (플랍/턴/리버) 표시
- **팟 크기 표시**: 테이블 펠트 중앙에 소형 글씨로 표시
- 스트릿 표시 (preflop / flop / turn / river / showdown)
- 현재 행동 순서 플레이어 하이라이트
- 각 플레이어 시트에 마지막 행동 배지 표시 (콜, 레이즈, 폴드, 체크, 올인 등)
- 딜러(D) / SB / BB 버튼 표시 (매 핸드 시계방향 로테이션)
- **자신의 홀카드만 시트에 표시** (상대방 뒷면 카드는 숨김)

### 행동 컨트롤
- 폴드 / 체크 / 콜 / 레이즈 / 올인
- 레이즈 프리셋 버튼: 1/3팟, 1/2팟, 3/4팟, 팟
- 레이즈 최솟값(minRaise) 강제 적용 (미달 시 서버에서 거부)
- **레이즈 버튼**: 핑크 배경 + 검정 글씨, 하단에 `최소 레이즈: N칩` 안내 표시
- 행동 타이머 바 + 카운트다운 (시간 초과 시 자동 폴드)

### 쇼다운
- 쇼다운 오버레이에 **보드 5장** + 각 플레이어 홀카드 + 한국어 패 이름 표시
- 승자 표시 + 획득 칩 표시
- 쇼다운 카운트다운 (20초) — 이후 다음 핸드 자동 시작
- 폴드로 팟 획득 시 패 공개 없이 5초 후 다음 핸드 시작

### 봇 시스템
- 방장이 봇 추가 / 제거 가능 (여러 봇 동시 추가 가능)
- 봇 AI: 핸드 강도 기반 행동 결정 (프리플랍 강도표 + 포스트플랍 pokersolver 평가)
- **블러프 비율 33%**: 약한 패(strength < 42)일 때 1/3 확률로 min-raise 블러프
- 봇 칩 소진 시 자동 리바이

### 리바이
- 인간 플레이어: 대기 중 / 칩 소진 시 리바이 버튼
- 봇: 핸드 시작 시 칩 0이면 자동 리바이

### 통계 드로어
- 📊 통계 버튼으로 열기/닫기
- 플레이어별 표시: 현재 칩, 손익(+/-), 바이인 총액, 승수
- 손익 기준 내림차순 정렬

### 방 관리
- 방장 전용 방 삭제 버튼 (대기 중 상태에서만 표시)
- 방 삭제 시 모든 참가자 로비로 자동 이동
- **마스터 관리자 패널**: 비밀번호(`chechebane`) 인증 후 서버의 모든 방 목록 조회·삭제 가능

### 게임 로그
- 화면 우측 하단 게임 로그 패널
- 각 행동, 팟 배분, 핸드 시작 등 기록

---

## 버그 수정 기록

### [중요] 마지막 행동이 UI에 표시되지 않는 버그
**증상**: 스트릿을 닫는 마지막 행동(예: BB 체크 → 플랍 전환)이 배지로 표시되지 않음  
**원인**: `advanceStreet` 호출 시 `lastAction = ''`로 초기화 후 broadcast → 마지막 행동이 덮어써짐  
**수정**: street-closing 행동 직후 즉시 `broadcast(room)` + 700ms setTimeout 후 `advanceStreet` 호출

```javascript
// server.js — handleAction 내부
collectBets(room);
room.actionSeat = -1;
broadcast(room);          // 마지막 행동 배지 먼저 노출
setTimeout(() => {
  if (rooms[room.code]) advanceStreet(room);
}, 700);
```

### 쇼다운 타이머가 5초에 잘리는 버그
**원인**: `NEXT_HAND_DELAY` 단일 상수를 폴드/쇼다운 모두에 사용  
**수정**: 두 상수로 분리

```javascript
const NEXT_HAND_DELAY_FOLD     = 5000;   // 폴드 승리 (5초)
const NEXT_HAND_DELAY_SHOWDOWN = 20000;  // 실제 쇼다운 (20초)
```

---

## 주요 구조

### 서버 이벤트 흐름
```
join-room → start-game → action(preflop) → advanceStreet(flop)
         → action(flop) → advanceStreet(turn)
         → action(turn) → advanceStreet(river)
         → action(river) → doShowdown → scheduleNextHand
```

### 관리자 이벤트
```
admin-list-rooms  { password }           → admin-room-list [ ]
admin-delete-room { password, roomCode } → admin-room-list [ ] + room-deleted (해당 방 전원)
```

### 상태 필드 (broadcast)
| 필드 | 설명 |
|------|------|
| `street` | waiting / preflop / flop / turn / river / showdown |
| `actionSeat` | 현재 행동 시트 번호 (-1이면 전환 중) |
| `pot` | 현재 팟 크기 |
| `communityCards` | 공개된 커뮤니티 카드 배열 |
| `showdownData` | 쇼다운 결과 (winners, hands) |
| `minRaise` | 최소 레이즈 금액 |
| `players[].lastAction` | 마지막 행동 문자열 |
| `players[].buyIn` | 누적 바이인 금액 |

### 봇 AI 의사결정 구조
```
strength = handStrength(room, player)   ← 0~100 점수
bluff    = strength < 42 && random < 0.33

if bluff && canRaise       → min-raise (블러프)
elif strength >= 72        → 0.75×팟 레이즈 (강한 패)
elif strength >= 55        → 콜 or 체크 (중간 패)
else                       → 팟 오즈 기반 콜 or 폴드
```

---

## 알려진 이슈 / 개선 가능 사항

1. **게임 중 입장 차단 없음**: `join-room` 핸들러에 `street === 'waiting'` 체크 미적용 → 진행 중 방 입장 시 홀카드 없이 착석
2. **봇 행동 딜레이 누적**: 봇 연속 행동 시 각 700ms 대기가 쌓여 체감상 느림
3. **toast 중첩**: 여러 행동이 빠르게 발생하면 토스트 알림이 쌓임
4. **handDescrKo 정규식**: pokersolver 영어 설명에 의존 → 라이브러리 업데이트 시 번역 깨질 수 있음
5. **test.js 실행 시간**: 쇼다운 대기 20초 포함으로 전체 테스트 약 30~35초 소요
