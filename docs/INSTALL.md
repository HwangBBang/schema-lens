# schema-lens 설치 가이드

이 문서는 schema-lens 를 소스 빌드 없이 Mac 에 설치하는 방법을 안내합니다. 가장 빠른 방법은
터미널 한 줄 설치입니다. 브라우저로 내려받아 설치했다면 처음 한 번만 터미널 명령으로 실행 차단을
풀면 됩니다. 소스에서 빌드하려면 README 의 [Build from source](../README.md#build-from-source) 를
보세요.

## 요구 사항

- macOS 12 이상
- Apple Silicon 과 Intel Mac 을 모두 지원합니다. 릴리스는 두 아키텍처를 한 앱에 담은 universal
  빌드입니다.

## 터미널 한 줄 설치

아래 명령을 터미널에 붙여 넣으면 최신 릴리스를 내려받아 `/Applications` 에 설치하고 실행합니다.
이미 설치한 schema-lens 가 있으면 새 버전으로 바꿉니다.

```bash
TMP=$(mktemp -d) && \
VER=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/HwangBBang/schema-lens/releases/latest | sed 's#.*/tag/v##') && \
curl -fL -o "$TMP/schema-lens.zip" "https://github.com/HwangBBang/schema-lens/releases/download/v$VER/schema-lens-$VER-universal-mac.zip" && \
ditto -xk "$TMP/schema-lens.zip" "$TMP" && \
rm -rf /Applications/schema-lens.app && \
mv "$TMP/schema-lens.app" /Applications/ && \
xattr -dr com.apple.quarantine /Applications/schema-lens.app && \
open /Applications/schema-lens.app && rm -rf "$TMP"
```

이 명령은 세 가지 일을 차례로 합니다.

1. 릴리스 페이지에서 최신 버전 번호를 읽고, 그 버전의 zip 파일을 임시 폴더에 내려받습니다.
2. 압축을 풀어 `/Applications/schema-lens.app` 자리에 넣습니다.
3. 격리 속성(인터넷에서 받은 파일이라는 표시)을 지우고 앱을 엽니다.

터미널의 `curl` 로 받은 파일에는 macOS 가 격리 속성을 붙이지 않습니다. 그래서 이 방법으로
설치하면 아래 "첫 실행이 막힐 때" 절의 실행 차단이 생기지 않습니다. 3번의 `xattr` 명령은 속성이 붙어
있는 경우에 대비한 것이고, 속성이 없으면 아무 일도 하지 않습니다.

## 직접 내려받아 설치

1. [최신 릴리스](https://github.com/HwangBBang/schema-lens/releases/latest) 페이지의 Assets 에서
   `schema-lens-<버전>-universal.dmg` 를 내려받습니다.
2. DMG 를 열고 `schema-lens.app` 을 Applications 폴더로 끌어다 놓습니다.
3. 처음 실행하기 전에 "첫 실행이 막힐 때" 절의 명령을 한 번 실행합니다.

## 첫 실행이 막힐 때

브라우저로 내려받은 파일에는 macOS 가 격리 속성(`com.apple.quarantine`)을 붙입니다. 이 속성이 붙은 앱을 처음 열면 Gatekeeper(앱의 서명을 확인해서 실행을 허용하거나
막는 macOS 기능)가 서명을 검사합니다. schema-lens 는 Apple 개발자 인증서(Developer ID)로 서명하지
않았고 공증(Apple 이 앱을 검사한 뒤 발급하는 확인 표시)도 받지 않았습니다. 그래서 Gatekeeper 가
실행을 막습니다.

막혔을 때 뜨는 창에는 앱이 손상되어 열 수 없다거나, Apple 이 악성 코드가 없음을 확인할 수 없다는
문장이 나옵니다. 이 문장은 서명을 확인하지 못했다는 뜻이고, 앱에서 악성 코드를 찾았다는 뜻은
아닙니다.

격리 속성을 지우면 Gatekeeper 가 이 검사를 하지 않으므로 앱이 열립니다. 터미널에서 아래 명령을
실행합니다.

```bash
xattr -dr com.apple.quarantine /Applications/schema-lens.app
open /Applications/schema-lens.app
```

한 번 지우면 그 뒤로는 더블클릭으로 열립니다. Finder 에서 우클릭한 뒤 "열기"를 고르는 방법은
macOS 15 부터 이 차단을 넘기지 못하므로, macOS 버전과 상관없이 위의 `xattr` 명령을 쓰는 것이
확실합니다.

## 업데이트

schema-lens 에는 자동 업데이트 기능이 없습니다. 새 버전이 나오면 터미널 한 줄 설치 명령을 다시
실행합니다. DMG 로 다시 설치했다면 "첫 실행이 막힐 때" 절의 명령도 다시 실행합니다.

스키마 라이브러리 목록과 파일별 레이아웃은 앱 바깥의 데이터 폴더에 저장되므로, 앱을 새 버전으로
바꿔도 그대로 남습니다.

## 삭제

1. `/Applications/schema-lens.app` 을 휴지통으로 옮깁니다.
2. 스키마 라이브러리 목록, 마지막으로 연 파일 기록, 파일별 레이아웃까지 지우려면
   `~/Library/Application Support/schema-lens` 폴더도 지웁니다. 이 폴더를 지워도 사용자가 열었던
   `.dbml` 파일은 그대로 남습니다.

## 문제 해결

| 증상 | 해결 |
|---|---|
| "손상되었기 때문에 열 수 없습니다" 또는 "확인할 수 없습니다" 창이 뜬다 | "첫 실행이 막힐 때" 절의 `xattr` 명령을 실행합니다. |
| 한 줄 설치가 `curl: (22)` 오류로 멈춘다 | 내려받기 주소가 바뀌었을 수 있습니다. "직접 내려받아 설치" 절을 따릅니다. |
| 앱이 열리지 않거나 바로 닫힌다 | macOS 12 이상인지 확인합니다. |
