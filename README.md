# Texas Hold'em — 친구들끼리 플레이

## 배포 (Render.com, 무료)

1. **GitHub에 올리기**
   ```
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/<YOUR_USERNAME>/<REPO>.git
   git push -u origin main
   ```

2. **Render.com에서 서비스 만들기**
   - https://render.com → Dashboard → **New +** → **Web Service**
   - GitHub 저장소 연결
   - 설정 (자동으로 `render.yaml`에서 읽히지만 수동 확인):
     - **Environment**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
   - **Create Web Service** 클릭

3. **접속**
   - 배포 완료 후 `https://texas-holdem-poker.onrender.com` 형태의 URL 생성
   - 해당 URL을 친구들에게 공유
   - 한 명이 방 만들기 → 방 코드 공유 → 나머지 입장

---

## 로컬 실행

```bash
npm install
npm start
# → http://localhost:3000
```

---

## 게임 규칙 / 기본값

| 항목 | 값 |
|------|-----|
| 시작 칩 | 20,000 |
| 스몰 블라인드 | 100 |
| 빅 블라인드 | 200 |
| 리바이 | +20,000 |
| 최대 인원 | 9명 |
| 다음 핸드 대기 | 쇼다운 후 5초 |

- **레이즈 최솟값**: 이전 레이즈 크기만큼 추가 (WSOP 규칙 적용)
- **사이드 팟**: 올인 시 자동 계산
- **연결 끊김**: 해당 플레이어 차례면 자동 폴드, 재접속 시 이름이 같으면 자리 복구

---

## 주의 — Render 무료 플랜 슬립

무료 플랜은 15분 동안 접속이 없으면 서버가 절전 모드로 전환됩니다.  
처음 접속 시 **약 30초 로딩**이 걸릴 수 있습니다. 그냥 기다리면 됩니다.
