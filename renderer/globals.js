// 번들 안에서 전역 이름을 세운다.
//
// src/semantics.js와 src/diff.js는 Node와 브라우저 양쪽을 지원하는 UMD 파일이라, 번들러가
// 감싸면 CommonJS 쪽 분기를 타서 전역(self.Semantics)이 만들어지지 않는다. 예전에는
// <script> 태그로 직접 읽혀 전역 분기를 탔지만 이제는 아니므로, 여기서 명시적으로 세운다.
//
// 이 파일은 app.js가 가장 먼저 import한다 — 다른 렌더러 파일이 평가되기 전에 전역이 서 있어야 한다.
// 렌더러를 TypeScript로 옮길 때 전역 대신 import로 바꾸면 이 파일은 사라진다.
import Semantics from '../src/semantics.js';
import SchemaDiff from '../src/diff.js';

window.Semantics = Semantics;
window.SchemaDiff = SchemaDiff;
