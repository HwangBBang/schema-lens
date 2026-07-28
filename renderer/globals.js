// 번들 안에서 전역 이름을 세운다.
//
// src/semantics.ts와 src/diff.ts는 이름 붙은 export를 내보내는 모듈이지만, 렌더러의 나머지
// 파일들은 아직 전역(Semantics, SchemaDiff)으로 서로를 찾는다. 그 사이를 여기서 잇는다.
//
// 이 파일은 app.js가 가장 먼저 import한다 — 다른 렌더러 파일이 평가되기 전에 전역이 서 있어야 한다.
// 렌더러를 TypeScript로 옮겨 import로 바꾸면 이 파일은 사라진다.
import * as Semantics from '../src/semantics.ts';
import * as SchemaDiff from '../src/diff.ts';

window.Semantics = Semantics;
window.SchemaDiff = SchemaDiff;
