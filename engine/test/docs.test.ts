/**
 * 文書どうしのつながりの検査。
 *
 * 日本語版と英語版を並べて置くと、**英語版から日本語版へ落ちる
 * リンク**が混ざる。読んでいる人は言語が切り替わったことにしか
 * 気づけず、書いた側は自分が読める言語で開くので気づけない
 * （実際に 4 箇所あり、利用者から指摘された）。
 *
 * ここで見るのは 3 つ。
 *
 *   1. 相対リンクの指す先が存在すること
 *   2. 英語版からは英語版へ張ること（言語切り替えの行を除く）
 *   3. 日本語版と英語版が対で揃い、互いを指していること
 *
 * engine 側に置いてあるのは、リポジトリで test runner があるのが
 * ここと `vscode-pli` だけで、`npm test` に自然に乗るため。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** 生成物と依存は見ない。 */
const SKIP_DIR = new Set([".git", "node_modules", "dist", "dist-web"]);

/**
 * 日本語版から英語版へ張ってよい文書。
 *
 * ルートの README は「英語版はこちら」と案内する行を持つ。
 * 日本語の読者に在り処を知らせるためのもので、誤りではない。
 */
const MAY_POINT_TO_ENGLISH = new Set(["README.md"]);

function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIP_DIR.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) out.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  walk(ROOT);
  return out;
}

const FILES = markdownFiles();

const isEnglish = (p: string): boolean => p.endsWith(".en.md") || p.startsWith("docs/en/");

/** 対になる相手の道。`docs/` だけ `docs/en/` に分けてある。 */
function counterpart(p: string): string {
  if (p.startsWith("docs/en/")) return `docs/${p.slice("docs/en/".length)}`;
  if (p.startsWith("docs/")) return `docs/en/${p.slice("docs/".length)}`;
  return p.endsWith(".en.md") ? `${p.slice(0, -".en.md".length)}.md` : `${p.slice(0, -".md".length)}.en.md`;
}

interface Link {
  from: string;
  label: string;
  target: string;
  /** リポジトリの根からの道。 */
  path: string;
}

function linksIn(file: string): Link[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: Link[] = [];
  for (const hit of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = hit[2] ?? "";
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    const path = relative(ROOT, resolve(ROOT, dirname(file), target.split("#")[0] ?? ""))
      .split(sep)
      .join("/");
    out.push({ from: file, label: hit[1] ?? "", target, path });
  }
  return out;
}

const LINKS = FILES.flatMap(linksIn);

/** 言語を切り替える行。向きの検査からは外す。 */
const isSwitcher = (l: Link): boolean => l.label === "日本語" || l.label === "English";

const where = (l: Link): string => `${l.from}: [${l.label}](${l.target})`;

describe("文書のリンク", () => {
  it("検査する対象がある（走査そのものが壊れていないこと）", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(20);
    expect(LINKS.length).toBeGreaterThanOrEqual(80);
  });

  it("指す先が存在する", () => {
    const broken = LINKS.filter((l) => {
      try {
        statSync(join(ROOT, l.path));
        return false;
      } catch {
        return true;
      }
    });
    expect(broken.map(where)).toEqual([]);
  });

  it("英語版から日本語版へ張らない", () => {
    const bad = LINKS.filter(
      (l) =>
        l.path.endsWith(".md") &&
        !isSwitcher(l) &&
        isEnglish(l.from) &&
        !isEnglish(l.path),
    );
    expect(bad.map(where), "英語版には英語版を指させる").toEqual([]);
  });

  it("日本語版から英語版へ張るのは案内の行だけ", () => {
    const bad = LINKS.filter(
      (l) =>
        l.path.endsWith(".md") &&
        !isSwitcher(l) &&
        !isEnglish(l.from) &&
        isEnglish(l.path) &&
        !MAY_POINT_TO_ENGLISH.has(l.from),
    );
    expect(bad.map(where)).toEqual([]);
  });
});

describe("日本語版と英語版の対", () => {
  it("どちらか片方だけの文書が無い", () => {
    const have = new Set(FILES);
    const alone = FILES.filter((p) => !have.has(counterpart(p)));
    expect(alone, "文書を足したら両方の言語で足す").toEqual([]);
  });

  it("互いを指している（頭の言語切り替え）", () => {
    const missing = FILES.filter(
      (p) => !LINKS.some((l) => l.from === p && isSwitcher(l) && l.path === counterpart(p)),
    );
    expect(missing, "頭に `**日本語** | [English](…)` の行を置く").toEqual([]);
  });
});
