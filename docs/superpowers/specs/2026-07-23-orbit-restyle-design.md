# Orbit-Mail 스타일 리디자인 설계 (2026-07-23)

레퍼런스: https://www.nextjsshop.com/templates/Orbit-Mail (라이브 데모 orbit-mail-nextjsshop-preview.vercel.app)

## 결정 사항

- 적용 범위: 앱 셸 전체 + ERD 카드 (풀 플로팅 레이아웃, A안)
- 폰트: UI 산세리프(시스템 스택) + ERD/포커스 카드 내부 모노 유지
- 프라이머리: 무채색(라이트 검정/다크 흰색 반전). `--accent`(블루)는 캔버스 기능색으로 존치
- 관계 의미색 8종·그룹색·pk/uq/real/logical·`--tint-chip` 불변

## 레퍼런스에서 추출한 디자인 언어

- 캔버스: 라이트 ≈#ebebeb / 다크 #111113(hsl 240 3.9% 7%) 위에 패널이 떠 있는 구조
- 패널: radius 16px, 1px 보더(#e7e7e7 / #252525), 배경 #fff / #1a1a1a, 그림자 거의 없음(보더 중심 분리)
- 사이드바는 캔버스 위 직접(패널 없음): 상단 계정/앱 헤더, 섹션 헤더(작은 muted), 항목 우측 카운트, 하단 고정 유틸
- 무채 + 단일 액센트, 라벨은 보더 칩, 세그먼트/기본 버튼은 검정↔흰 반전
- 패널 상단 내부 툴바: ghost 아이콘 버튼 + 얇은 세로 구분선
- 빈 상태: 중앙 원형 muted 글리프 + 제목 + muted 설명 + 버튼 행

## 셸 구조 (index.html — 기존 id 전부 유지)

```
.app (캔버스색, padding 10px, gap 10px)
├─ aside.side (배경 없음, 폭 248px)
│   ├─ .side-head   파일명 + 메타(brand-title/brand-sub 이동)
│   ├─ .search      검색 input (흰 카드형)
│   ├─ .list        그룹 섹션 헤더 + 항목 (현행 유지, 톤만)
│   └─ .side-foot   파일 열기(#open) · 테마 전환(#theme)
└─ main.stage-panel (radius 16, 1px 보더, overflow hidden)
    ├─ .ptoolbar    #side-toggle · 모드/필터/컬럼 세그먼트 · (포커스 시 #crumb) · #fit
    ├─ stagewrap    #erdwrap(#erd+#minimap) / #focuswrap / #welcome / #errbar
    └─ .plegend     #legend 내용 이동 (범례 스트립)
```

풀블리드 `header.bar`와 하단 `.legend` 바는 제거.

## 컴포넌트

- 세그먼트: muted 트랙 + 선택 항목 `--primary` 반전
- 아이콘 버튼: 보더 없는 ghost, hover muted 배경, 그룹 사이 세로 구분선
- 사이드바 항목: hover/active 무채 배경, 좌측 파란 보더 제거, 카운트 muted 유지
- welcome: Orbit 빈 상태 문법 (원형 글리프 + 제목 + 설명 + primary 버튼)
- ERD 카드: SVG 상수 불변. rx 통일, 보더 `--line`, 그림자 축소. 그룹색 틴트/액센트바/N:M 뱃지/선택 `--accent` 유지
- 포커스 카드: radius 12, 그림자 축소, 좌 3px 그룹색 보더 유지, 로직 무변경
- 미니맵: 범례 스트립 위 오프셋, 파란 테두리 제거

## 구현 영향

| 파일 | 변경 |
|---|---|
| renderer/index.html | 헤더 해체 → side-head/side-foot/ptoolbar 신설 |
| renderer/style.css | 토큰 교체 + 셸/컴포넌트 룰 재작성 (최대) |
| renderer/app.js | 사이드바 접힘·테마 토글 등 소폭 |
| renderer/erd.js | 미니맵 오프셋·fit 마진 확인 |
| renderer/focus.js | crumb 이동 참조 확인 (id 유지 시 무수정 기대) |
| main.js | 창 backgroundColor 2값 갱신 |
| scripts/check-contrast.js | on-primary/primary 페어 추가 |

## 검증

1. `npm test` — 110 asserts 녹색 (모델 테스트, 회귀 확인)
2. `npm run test:contrast` — fails: light=0 dark=0
3. 스크린샷 CLI: 라이트/다크 × ERD/포커스 4종 육안 확인 (Electron 순차 실행)

## v2 보강 (2026-07-23, 사용자 피드백 반영)

v1 평가 "1/10" — 진단: 흰 패널 위 흰 카드로 도형/배경 대비 소실, 사이드바·툴바가 미완성으로 보임,
캔버스 내용물 무변화. 보강 내용:

- 드로잉 서페이스: `--surface`/`--dot` 토큰 신설, ERD·포커스 캔버스에 24px 도트 그리드
  (ERD는 팬 동기화, 포커스는 attachment:local). 카드가 다시 뜨도록 레이어드 그림자 2단.
- 카드: 타이틀 산세리프 세미볼드, 헤더 틴트 11%.
- 사이드바: 프라이머리 글리프 + 파일명/메타 헤드, 아이콘 검색창(+포커스 링), 항목별 그룹색 도트.
- 툴바: 우측 상태 칩(tables·refs) + fit + 테마 버튼(접힘 시 도달성 확보). side-foot은 DBML 열기만.
- 엣지: 기본 opacity .6/1.8px, hover·선택 컨텍스트 풀 강조.
- 리뷰 확정 발견 반영: --side 죽은 토큰 삭제, 크럼 ellipsis, check-contrast 표면 페어 보강
  (gc-6 #d11e6b·gc-7 #5d6b82·다크 faint #92929a 조정).

## v3 보강 (2026-07-23, 2차 피드백 6건 반영)

1. 하단 범례 바 제거 → 툴바 ⓘ 버튼으로 여닫는 플로팅 팝오버(#legend, 실/논리선·유형 칩·허브 토글·힌트).
2. 사이드바 그룹 = 접을 수 있는 섹션: 셰브런+색점+그룹명+개수, localStorage(dbv-grps) 유지,
   검색 중 임시 펼침(.list.searching), 활성 항목이 접힌 그룹이면 자동 펼침.
3. 포커스 모드가 키만/전체 컬럼을 따름(ERD와 동일 규칙: PK/UNIQUE/FK 멤버) + "…N개 컬럼 더" 행.
4. 포커스 UX 정리: 장황한 가이드 문장/이중 헤더 제거 → 슬림 한 줄 헤드(툴팁으로 설명 이동),
   포커스 카드도 솔리드 헤더, 이웃 카드는 좌측 색 보더 대신 색점.
5. 카드 촌스러움 해소: 좌측 액센트바·헤더 틴트 폐기 → dbdiagram식 솔리드 그룹색 헤더
   (+--hd-ink/--hd-chip 토큰, hd-ink/gc 대비 페어 11종 추가).
6. 드로잉 dbdiagram 차용: 캔버스 평평한 근백색(#fbfbfb/#141416, 도트 그리드 폐기),
   엣지 기본 중립 회색(--edge) 1.5px + hover/선택 컨텍스트에서만 유형색, 행 구분선 개념 제거.
   gc-x 라이트 #64748b·다크 #9aa8bb(다크 오버라이드 신설), gc-6/#d11e6b 유지.

## v4 보강 (2026-07-23, 타이틀바 제거)

- macOS 한정 titleBarStyle:'hidden' + trafficLightPosition {x:16,y:16} — 상단 타이틀바 제거,
  신호등을 사이드바 상단에 인셋(GPT 데스크톱앱 방식).
- body.titlebar-hidden: side-head 상단 36px 여백, side-head/ptoolbar 창 드래그 영역
  (내부 컨트롤은 no-drag), 사이드바 접힘 시 툴바 좌측 76px로 신호등 자리 확보.

## v5 보강 (2026-07-23, 툴바를 캔버스 배경 위로)

- 툴바(.ptoolbar)를 stage-panel 밖 .main 컬럼으로 분리 — 배경이 캔버스색(--bg)이 되어
  사이드바 접힘 시 신호등과 같은 표면에 놓임. 패널은 툴바 없는 클린 라운드 카드.

## v6 보강 (2026-07-23, ERD 정렬 방식 + 지도 하단 정렬 바)

- 정렬 4종: 그룹(기존 ELK 컴파운드) / 가로 흐름(layered RIGHT, 그룹 해제) /
  세로 흐름(layered DOWN, 그룹 해제) / 격자(그룹 순서 균등 나열, 수동 배치).
- UX: 지도 하단 중앙 플로팅 바(#arrange) — dbdiagram 도구 칩 문법, 선택 = primary 반전.
- 그룹 외 모드에선 헐/그룹 라벨 숨김(흩어진 멤버에 헐이 오해를 만듦).
- 방식은 파일별 localStorage(dbv-lay:*) 유지, 정렬 실행 시 커스텀 배치 폐기 후 새 배치 저장.
- CLI `--layout group|lr|tb|grid` 원샷 추가(스크린샷·docs 촬영용, arrange와 동일하게 저장까지 수행).
