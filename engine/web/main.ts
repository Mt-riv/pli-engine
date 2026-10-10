/**
 * ブラウザ版。エンジンはブラウザ内で完結して動くのでサーバを必要としない。
 *
 * 外部ライブラリに依存しないため、エディタは行番号付きの textarea で作る。
 * Monaco などを使うと CDN への接続が必要になり、オフラインで動かなくなる。
 */

import {
  lint,
  MemoryHost,
  runProgram,
  runTestSource,
  formatReport,
  isTestSource,
  plainText,
  SNIPPETS,
  VERSION,
  loadMfs,
  Session,
  type Aid,
  type LintMessage,
  type SessionStep,
} from "../src/index.js";
import { SAMPLES } from "./samples.js";
import { decodePayload, share } from "./share.js";
import { insertSnippet } from "./insert.js";
import { parseFiles, psbNames, serializeFiles, splitAux } from "./files.js";
import { functionKeys, Terminal } from "./terminal.js";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const src = $<HTMLTextAreaElement>("src");
const gutter = $<HTMLDivElement>("gutter");
const out = $<HTMLPreElement>("out");
const diags = $<HTMLDivElement>("diags");
const status = $<HTMLSpanElement>("status");
/** 共有 URL から読み込んだときに出す確認バー。 */
const sharedBar = $<HTMLDivElement>("shared");
const sharedRunBtn = $<HTMLButtonElement>("shared-run");
const sharedDismissBtn = $<HTMLButtonElement>("shared-dismiss");
const pos = $<HTMLSpanElement>("pos");
const runBtn = $<HTMLButtonElement>("run");
const shareBtn = $<HTMLButtonElement>("share");
const lintBtn = $<HTMLButtonElement>("lint");
const filesBtn = $<HTMLButtonElement>("files");
const aux = $<HTMLTextAreaElement>("aux");
const drawer = $<HTMLDivElement>("drawer");
const drawerHint = $<HTMLSpanElement>("drawer-hint");
const stdinBox = $<HTMLTextAreaElement>("stdin");
const tabFiles = $<HTMLButtonElement>("tab-files");
const tabStdin = $<HTMLButtonElement>("tab-stdin");
const sampleSel = $<HTMLSelectElement>("sample");
const snippetSel = $<HTMLSelectElement>("snippet");
const outTitle = $<HTMLSpanElement>("out-title");
const termBtn = $<HTMLButtonElement>("term-btn");
const termPane = $<HTMLDivElement>("term");
const termScreen = $<HTMLDivElement>("term-screen");
const termMod = $<HTMLInputElement>("term-mod");
const termStart = $<HTMLButtonElement>("term-start");
const termEnter = $<HTMLButtonElement>("term-enter");
const termKey = $<HTMLSelectElement>("term-key");
const termSend = $<HTMLButtonElement>("term-send");
const termNext = $<HTMLButtonElement>("term-next");

$("ver").textContent = `v${VERSION}`;

/** 診断のある行。行番号の色を変えるために持つ。 */
let badLines = new Set<number>();

// ---- 行番号 ----

function currentLine(): number {
  return src.value.slice(0, src.selectionStart).split("\n").length;
}

function renderGutter(): void {
  const total = src.value.split("\n").length;
  const cur = currentLine();
  const parts: string[] = [];
  for (let i = 1; i <= total; i++) {
    const cls = badLines.has(i) ? "bad" : i === cur ? "cur" : "";
    parts.push(cls ? `<span class="${cls}">${i}</span>` : String(i));
  }
  gutter.innerHTML = parts.join("\n");
  gutter.scrollTop = src.scrollTop;
}

function updatePos(): void {
  const upto = src.value.slice(0, src.selectionStart);
  const lines = upto.split("\n");
  pos.textContent = `${lines.length}:${(lines[lines.length - 1] ?? "").length + 1}`;
}

src.addEventListener("input", () => {
  renderGutter();
  updatePos();
  save();
});
src.addEventListener("scroll", () => {
  gutter.scrollTop = src.scrollTop;
});
for (const ev of ["click", "keyup", "select"] as const) {
  src.addEventListener(ev, () => {
    renderGutter();
    updatePos();
  });
}

// Tab はインデントに使う（フォーカス移動を抑える）
src.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = src.selectionStart;
    const t = src.selectionEnd;
    src.setRangeText("  ", s, t, "end");
    renderGutter();
    return;
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

// ---- 永続化と共有 ----

const KEY = "pli-engine-source";

function save(): void {
  try {
    localStorage.setItem(KEY, src.value);
  } catch {
    // プライベートウィンドウなどで失敗しても動作に影響させない
  }
}

shareBtn.addEventListener("click", () => {
  void share(
    location.href,
    // 付随ファイルと標準入力も載せる。ソースだけでは
    // %INCLUDE・ファイル入出力・DL/I のプログラムが受け取った側で動かない
    { source: src.value, aux: aux.value, stdin: stdinBox.value },
    navigator.clipboard,
    (hash) => {
      location.hash = hash;
    },
  ).then((r) => {
    status.innerHTML = `<span class="ok">${r.message}</span>`;
  });
});

// ---- 付随ファイル ----

const AUX_KEY = "pli-engine-aux";
const STDIN_KEY = "pli-engine-stdin";

/** 引き出しの面を切り替える。 */
function showPane(which: "files" | "stdin"): void {
  aux.classList.toggle("hidden", which !== "files");
  stdinBox.classList.toggle("hidden", which !== "stdin");
  tabFiles.classList.toggle("on", which === "files");
  tabStdin.classList.toggle("on", which === "stdin");
  updateDrawerHint();
}

/**
 * 付随ファイル欄からホストを作る。
 * `%INCLUDE` の取り込み元と、ファイル入出力の相手になる。
 */
function buildHost(): MemoryHost {
  return new MemoryHost(parseFiles(aux.value), stdinBox.value);
}

/**
 * DL/I を使うかどうか。付随ファイルに `<名前>.psb` が 1 つだけあれば使う。
 * 2 つ以上あるとどちらか決められないので、何も渡さずに知らせる。
 */
function dliOptions(): { psb?: string } {
  const names = psbNames(parseFiles(aux.value));
  if (names.length === 1) return { psb: names[0]! };
  if (names.length > 1) {
    out.textContent =
      `PSB が ${names.length} つあります（${names.join(", ")}）。` +
      "使うものだけを付随ファイルに置いてください。\n\n";
  }
  return {};
}

/**
 * 実行で書き出されたファイルを欄に反映する。
 *
 * プログラムが `put file(rep)` で作ったファイルは、画面に出さないと
 * どこにも現れない。実行後に書き戻して、そのまま次の入力にも使えるようにする。
 */
function syncFilesFromHost(host: MemoryHost): void {
  // 区切りより前の文章（利用者のメモなど）を保つ。
  // 捨てると「実行したら書いたものが消えた」ことになる
  const { preamble, files: before } = splitAux(aux.value);
  const after = host.entries();
  // 大文字小文字を無視して突き合わせ、元の名前を保つ
  const lower = new Map(Object.keys(before).map((k) => [k.toUpperCase(), k]));
  let changed = false;
  for (const [name, contents] of Object.entries(after)) {
    const key = lower.get(name.toUpperCase()) ?? name;
    if (before[key] !== contents) {
      before[key] = contents;
      changed = true;
    }
  }
  if (!changed) return;
  aux.value = serializeFiles(before, preamble);
  updateDrawerHint();
  try {
    localStorage.setItem(AUX_KEY, aux.value);
  } catch {
    // 保存できなくても動作には影響させない
  }
}

/** 引き出しの見出しに、いま何が入っているかを出す。 */
function updateDrawerHint(): void {
  const names = Object.keys(parseFiles(aux.value));
  if (!stdinBox.classList.contains("hidden")) {
    const lines = stdinBox.value === "" ? 0 : stdinBox.value.replace(/\n$/, "").split("\n").length;
    drawerHint.textContent =
      lines === 0 ? "GET LIST / GET EDIT が読む内容" : `${lines} 行`;
  } else {
    drawerHint.textContent =
      names.length === 0
        ? "「::: 名前」の行で区切って書く"
        : `${names.length} 個: ${names.join(", ")}`;
  }
  filesBtn.classList.toggle("on", names.length > 0 || stdinBox.value !== "");
}

aux.addEventListener("input", () => {
  updateDrawerHint();
  try {
    localStorage.setItem(AUX_KEY, aux.value);
  } catch {
    // 保存できなくても動作には影響させない
  }
});

stdinBox.addEventListener("input", () => {
  updateDrawerHint();
  try {
    localStorage.setItem(STDIN_KEY, stdinBox.value);
  } catch {
    // 保存できなくても動作には影響させない
  }
});

tabFiles.addEventListener("click", () => showPane("files"));
tabStdin.addEventListener("click", () => showPane("stdin"));

filesBtn.addEventListener("click", () => {
  drawer.classList.toggle("hidden");
  if (!drawer.classList.contains("hidden")) {
    (stdinBox.classList.contains("hidden") ? aux : stdinBox).focus();
  }
});

// ---- 実行 ----

/** テストファイルとして実行し、報告を出力欄に出す。 */
function runTests(): void {
  const testHost = buildHost();
  const report = runTestSource(src.value, {
    maxSteps: 5_000_000,
    maxOutputBytes: 1_000_000,
    host: testHost,
    ...dliOptions(),
  });
  syncFilesFromHost(testHost);

  outTitle.textContent = "テストの結果";
  out.textContent = formatReport(report, "テスト", { failedOutput: true }) + "\n";

  const bits: string[] = [];
  bits.push(
    report.ok
      ? '<span class="ok">成功</span>'
      : '<span class="err">失敗</span>',
  );
  bits.push(`テスト ${report.total}`);
  bits.push(`成功 ${report.passed}`);
  if (report.failures > 0) bits.push(`<span class="err">失敗 ${report.failures}</span>`);
  if (report.errors > 0) bits.push(`<span class="err">異常 ${report.errors}</span>`);
  if (report.skipped > 0) bits.push(`省略 ${report.skipped}`);
  bits.push(`${report.durationMs}ms`);
  status.innerHTML = bits.join(" / ");

  renderGutter();
  runBtn.disabled = false;
}

function run(): void {
  runBtn.disabled = true;
  out.textContent = "";
  diags.classList.add("hidden");
  badLines = new Set();

  // 主手続きが無く TEST_ 手続きがあるならテストとして走らせる。
  // そのまま実行しても「主手続きが無い」で終わるだけなので。
  if (isTestSource(src.value, buildHost())) {
    runTests();
    return;
  }
  outTitle.textContent = "出力";

  const host = buildHost();
  const dli = dliOptions();
  const note = out.textContent ?? "";
  const r = runProgram(src.value, {
    // ブラウザを固めないための上限。別プロセスが無いので
    // エンジン側で文の数と出力量を制限する。
    maxSteps: 5_000_000,
    maxOutputBytes: 1_000_000,
    host,
    ...dli,
  });
  syncFilesFromHost(host);

  out.textContent = note + r.stdout;

  if (r.diagnostics.length > 0) {
    showDiagnostics(
      r.diagnostics.map((d) => ({
        line: d.line,
        col: d.col,
        file: d.file,
        text: d.message,
        kind: "error" as const,
      })),
    );
  }

  const bits: string[] = [];
  bits.push(r.ok ? '<span class="ok">成功</span>' : '<span class="err">失敗</span>');
  if (r.truncated) bits.push("出力打ち切り");
  bits.push(`${r.durationMs}ms`);
  bits.push(`${r.stdout.split("\n").length - 1}行出力`);
  status.innerHTML = bits.join(" / ");

  renderGutter();
  runBtn.disabled = false;
}

// ---- 端末（MFS の画面） ----

/**
 * 画面入出力は「1 回の入力 = 1 回のプログラム実行」で回す。
 *
 * 実機の MPP と同じ形なので、実行器を止めて人の入力を待つ必要がない。
 * ブラウザで待つには Worker と SharedArrayBuffer が要り、
 * そのためのヘッダ（COOP/COEP）はサーバを必要とするので、
 * 「HTML 1 枚で動く」という前提が壊れる。
 */
const terminal = new Terminal(termScreen);
let session: Session | undefined;

for (const k of functionKeys()) {
  const opt = document.createElement("option");
  opt.value = k.label;
  opt.textContent = k.label;
  termKey.appendChild(opt);
}

/** 端末の表示を切り替える。 */
function showTerminal(on: boolean): void {
  termPane.classList.toggle("hidden", !on);
  out.classList.toggle("hidden", on);
  termBtn.classList.toggle("on", on);
  outTitle.textContent = on ? "端末（3270）" : "出力";
  if (on && termMod.value === "") termMod.value = firstMod();
}

/** 台本（`MOD 名前`）から最初に出す画面の名前を拾う。 */
function modOfScript(keys: string): string {
  for (const line of keys.split("\n")) {
    const m = /^\s*MOD\s+(\S+)/i.exec(line);
    if (m) return m[1]!.toUpperCase();
  }
  return "";
}

/** 付随ファイルにある書式定義から、最初の出力用の記述を選ぶ。 */
function firstMod(): string {
  try {
    const lib = loadMfs(parseFiles(aux.value));
    for (const [name, m] of lib.messages) if (m.type === "OUTPUT") return name;
  } catch {
    // 書式定義の誤りは「開始」を押したときに知らせる
  }
  return "";
}

/** 端末を開始する（最初の画面を出す）。 */
function startSession(): void {
  const files = parseFiles(aux.value);
  const psbs = psbNames(files);
  if (psbs.length !== 1) {
    termScreen.textContent =
      "入出力 PCB を含む PSB を 1 つだけ、付随ファイルに置いてください" +
      `（いま ${psbs.length} 個）。`;
    return;
  }
  let library;
  try {
    library = loadMfs(files);
  } catch (e) {
    termScreen.textContent = `書式定義が読めません: ${(e as Error).message}`;
    return;
  }
  if (library.empty) {
    termScreen.textContent =
      "書式定義がありません。付随ファイルに「::: 名前.mfs」で FMT と MSG を書いてください。";
    return;
  }
  const host = buildHost();
  session = new Session({
    source: src.value,
    library,
    host,
    psb: psbs[0]!,
    ...(termMod.value.trim() === "" ? {} : { mod: termMod.value.trim().toUpperCase() }),
    lterm: "WEBTERM1",
    now: () => new Date(),
    limits: { maxSteps: 5_000_000, maxOutputBytes: 1_000_000 },
  });
  showStep(session.start(), host);
}

/** 1 回の往復の結果を画面と状態欄に出す。 */
function showStep(step: SessionStep, host: MemoryHost): void {
  syncFilesFromHost(host);
  terminal.render(step.screen);
  out.textContent = step.stdout;
  if (step.diagnostics.length > 0) {
    showDiagnostics(
      step.diagnostics.map((d) => ({
        line: d.line,
        col: d.col,
        file: d.file,
        text: d.message,
        kind: "error" as const,
      })),
    );
  } else {
    diags.classList.add("hidden");
    badLines = new Set();
    renderGutter();
  }
  const bits: string[] = [];
  bits.push(step.ok ? '<span class="ok">成功</span>' : '<span class="err">失敗</span>');
  if (step.notice !== undefined) bits.push(`通知: ${step.notice}`);
  if (step.queued > 0) bits.push(`未出力 ${step.queued} 件`);
  if (session?.inConversation === true) bits.push("会話中");
  if (session?.inputFormat !== undefined) bits.push(`次の入力 ${session.inputFormat}`);
  status.innerHTML = bits.join(" / ");
}

/** 送る。押したキーと、打ち込んだ値を渡す。 */
function sendKey(aid: Aid, fields: Map<string, string>): void {
  if (session === undefined) {
    status.textContent = "先に「開始」を押してください";
    return;
  }
  const host = buildHost();
  // ホストは実行をまたいで引き継ぐ（データベースの更新を残すため）
  showStep(session.send({ aid, fields }), host);
}

terminal.listen(sendKey);
termBtn.addEventListener("click", () => showTerminal(termPane.classList.contains("hidden")));
termStart.addEventListener("click", startSession);
termEnter.addEventListener("click", () => terminal.submit({ kind: "enter" }));
termSend.addEventListener("click", () => {
  const found = functionKeys().find((k) => k.label === termKey.value);
  if (found !== undefined) terminal.submit(found.aid);
});
termNext.addEventListener("click", () => {
  if (session === undefined) return;
  showStep(session.next(), buildHost());
});

interface DiagEntry {
  line: number;
  col?: number;
  /** 取り込み元のファイル名（%INCLUDE した先の誤り）。 */
  file?: string;
  text: string;
  kind: "error" | "warning" | "info";
  /** Linter の規則 id。 */
  rule?: string;
}

/** 診断の一覧を描く。クリックでその行へ飛ぶ。 */
function showDiagnostics(entries: DiagEntry[]): void {
  badLines = new Set(entries.filter((e) => e.kind !== "info").map((e) => e.line));
  const ul = document.createElement("ul");
  for (const e of entries) {
    const li = document.createElement("li");
    if (e.kind === "warning") li.className = "warn";
    if (e.kind === "info") li.className = "info";
    const where = e.col === undefined ? `${e.line}行` : `${e.line}行${e.col}桁`;
    // 取り込んだ先の誤りは、どのファイルの何行目かを示す
    li.textContent = `${e.file ? `${e.file} ` : ""}${where}: ${e.text}`;
    if (e.rule) {
      const span = document.createElement("span");
      span.className = "rule";
      span.textContent = ` [${e.rule}]`;
      li.appendChild(span);
    }
    if (e.file === undefined) li.addEventListener("click", () => jumpTo(e.line));
    else li.style.cursor = "default";
    ul.appendChild(li);
  }
  diags.innerHTML = "";
  diags.appendChild(ul);
  diags.classList.remove("hidden");
  renderGutter();
}

/**
 * 実行せずに検査だけを行う。
 * 構文が通っていれば Linter の指摘も出す。
 */
function runLint(): void {
  out.textContent = "";
  diags.classList.add("hidden");
  badLines = new Set();
  outTitle.textContent = "出力";

  // 文を1つも実行させないことで解析だけを行う
  const host = buildHost();
  const syntax = runProgram(src.value, { maxSteps: 0, host }).diagnostics.filter(
    (d) => d.phase !== "runtime",
  );
  if (syntax.length > 0) {
    showDiagnostics(
      syntax.map((d) => ({
        line: d.line,
        col: d.col,
        file: d.file,
        text: d.message,
        kind: "error" as const,
      })),
    );
    status.innerHTML = '<span class="err">構文に誤りがあります</span>';
    return;
  }

  const messages: LintMessage[] = lint(src.value, { host });
  if (messages.length === 0) {
    status.innerHTML = '<span class="ok">指摘はありません</span>';
    renderGutter();
    return;
  }
  showDiagnostics(
    messages.map((m) => ({
      line: m.line,
      col: m.col,
      text: m.message,
      kind: m.severity === "error" ? "error" : m.severity === "warning" ? "warning" : "info",
      rule: m.rule,
    })),
  );
  const n = (k: string) => messages.filter((m) => m.severity === k).length;
  status.innerHTML =
    `<span class="err">指摘 ${messages.length}</span>` +
    ` / 誤り ${n("error")} / 警告 ${n("warning")} / 情報 ${n("info")}`;
}


/** 指定の行にカーソルを移す。 */
function jumpTo(line: number): void {
  const lines = src.value.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
    offset += (lines[i] ?? "").length + 1;
  }
  src.focus();
  src.setSelectionRange(offset, offset + (lines[line - 1] ?? "").length);
  renderGutter();
  updatePos();
}

runBtn.addEventListener("click", run);
lintBtn.addEventListener("click", () => runLint());
lintBtn.title = "実行せずに検査する";

// ---- 初期化 ----

for (const [i, s] of SAMPLES.entries()) {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = s.name;
  sampleSel.appendChild(o);
}
const snippetHead = document.createElement("option");
snippetHead.textContent = "Snippet…";
snippetHead.value = "";
snippetSel.appendChild(snippetHead);
for (const [i, sn] of SNIPPETS.entries()) {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = `${sn.name}  (${sn.prefix})`;
  o.title = sn.description;
  snippetSel.appendChild(o);
}
snippetSel.addEventListener("change", () => {
  const sn = SNIPPETS[Number(snippetSel.value)];
  snippetSel.value = "";
  if (!sn) return;
  const r = insertSnippet(
    src.value,
    src.selectionStart,
    src.selectionEnd,
    plainText(sn.body),
  );
  src.value = r.text;
  src.focus();
  src.setSelectionRange(r.cursor, r.cursor);
  renderGutter();
  updatePos();
  save();
});

sampleSel.addEventListener("change", () => {
  const s = SAMPLES[Number(sampleSel.value)];
  if (s) {
    src.value = s.source;
    // 付随ファイルを持つサンプル（DL/I など）は、それが無いと動かない
    if (s.aux !== undefined) aux.value = s.aux;
    renderGutter();
    updatePos();
    save();
    if (s.keys !== undefined) {
      // 画面入出力のサンプルは、ふつうに実行しても
      // 「メッセージキューが無い」で終わる。端末を開いて最初の画面を出す
      termMod.value = modOfScript(s.keys);
      showTerminal(true);
      startSession();
      return;
    }
    showTerminal(false);
    run();
  }
});

try {
  aux.value = localStorage.getItem(AUX_KEY) ?? "";
  stdinBox.value = localStorage.getItem(STDIN_KEY) ?? "";
} catch {
  aux.value = "";
  stdinBox.value = "";
}
updateDrawerHint();

const shared = decodePayload(location.hash);
let saved: string | null = null;
try {
  saved = localStorage.getItem(KEY);
} catch {
  saved = null;
}
src.value = shared?.source ?? saved ?? SAMPLES[0]!.source;
if (shared !== undefined) {
  // 付随ファイルと標準入力も復元する。無ければ空にする
  // （受け取った側の内容が混ざると、動いているように見えて実は違う）
  aux.value = shared.aux ?? "";
  stdinBox.value = shared.stdin ?? "";
  updateDrawerHint();
}
renderGutter();
updatePos();

if (shared === undefined) {
  // 自分の手元のコードなので、そのまま走らせてよい
  run();
} else {
  // **共有 URL のコードは自動実行しない。**
  // 他人から受け取った URL を開くだけで、無限ループや
  // 記憶域の確保でタブを固められる。中身を見てから押してもらう。
  sharedBar.classList.remove("hidden");
  status.textContent = "共有されたコードを読み込みました（まだ実行していません）";
  // ハッシュを消す。残すと、編集して読み込み直したときに
  // 保存した内容ではなく古いハッシュが優先される
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // file:// などで失敗しても動作に影響させない
  }
  save();
}

sharedRunBtn.addEventListener("click", () => {
  sharedBar.classList.add("hidden");
  run();
});
sharedDismissBtn.addEventListener("click", () => {
  sharedBar.classList.add("hidden");
});
