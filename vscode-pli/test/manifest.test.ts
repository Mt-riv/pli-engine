/**
 * package.json の寄与の検証。
 *
 * `.pli` は別の拡張によって言語 `pl1` として開かれることがある。
 * `when` 句が `pli` だけだと、そのときキー割り当てもコマンドパレットも
 * 一切働かない。実際にそれで動作しない状態になったので、
 * 両方の言語 ID を受けることをテストで固定する。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  activationEvents: string[];
  license: string;
  capabilities?: {
    untrustedWorkspaces?: { supported: boolean | string; description?: string };
    virtualWorkspaces?: boolean;
  };
  contributes: {
    commands: { command: string }[];
    keybindings: { command: string; key: string; mac?: string; when: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    snippets: { language: string; path: string }[];
    languages: { id: string; extensions: string[] }[];
    configuration: {
      properties: Record<
        string,
        { type: string; default: unknown; minimum?: number; pattern?: string }
      >;
    };
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
);

/** 言語を見る when 句（`editorLangId` を使う箇所があれば拾えるようにしている）。 */
function langClauses(): string[] {
  const out = manifest.contributes.keybindings.map((k) => k.when);
  for (const entries of Object.values(manifest.contributes.menus)) {
    for (const e of entries) if (e.when) out.push(e.when);
  }
  return out.filter((w) => w.includes("LangId"));
}

describe("package.json の寄与", () => {
  it("pli と pl1 の両方で活性化する", () => {
    expect(manifest.activationEvents).toContain("onLanguage:pli");
    expect(manifest.activationEvents).toContain("onLanguage:pl1");
  });

  it("言語を見る when 句はすべて pl1 も受ける", () => {
    const clauses = langClauses();
    expect(clauses.length).toBeGreaterThan(0);
    for (const w of clauses) {
      expect(w, `pl1 を受けていない: ${w}`).toContain("pl1");
      expect(w).toContain("pli");
    }
  });

  it("コマンドは 3 つ揃っている", () => {
    expect(manifest.contributes.commands.map((c) => c.command).sort()).toEqual([
      "pli.run",
      "pli.runTests",
      "pli.runWithArgs",
    ]);
  });

  it("実行とテストにキーが割り当てられている", () => {
    const keys = Object.fromEntries(
      manifest.contributes.keybindings.map((k) => [k.command, k.mac]),
    );
    expect(keys["pli.run"]).toBe("cmd+alt+r");
    expect(keys["pli.runTests"]).toBe("cmd+alt+t");
  });

  it("宣言的 Snippet は自分が登録する言語にだけ寄与する", () => {
    // 宣言していない言語 ID（pl1 は別の拡張のもの）に寄与すると
    // 「Unknown language」の警告が出る。pl1 側は補完として提供している
    const declared = manifest.contributes.languages.map((l) => l.id);
    for (const s of manifest.contributes.snippets) {
      expect(declared, `宣言していない言語への寄与: ${s.language}`).toContain(
        s.language,
      );
      expect(s.path).toBe("./snippets/pli.json");
    }
    expect(manifest.contributes.snippets.map((s) => s.language)).toEqual(["pli"]);
  });

  it("Snippet ファイルが生成済みで中身がある", () => {
    const p = join(import.meta.dirname, "../snippets/pli.json");
    const snippets = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    expect(Object.keys(snippets).length).toBeGreaterThanOrEqual(28);
  });
});

describe("DL/I の設定", () => {
  interface WithConfig {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  }
  const withConfig: WithConfig = JSON.parse(
    readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
  );

  it("PSB の名前を設定できる", () => {
    const props = withConfig.contributes.configuration.properties;
    expect(props["pli.dli.psb"]).toBeDefined();
    // 既定では DL/I を使わない（指定しないかぎり何も読まない）
    expect(props["pli.dli.psb"]!.default).toBe("");
  });
});


/**
 * 配布に関わる宣言。
 *
 * vsix には `package.json` がそのまま入るので、ここの宣言が
 * 利用者に見えるものになる。ルートの LICENSE と食い違うと
 * 「このコードを使っていいか」の答えが逆になる。
 */
describe("配布と権限の宣言", () => {
  it("ライセンスはルートと同じ MIT", () => {
    expect(manifest.license).toBe("MIT");
  });

  it("Workspace Trust を明示している（既定に頼らない）", () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false);
  });

  it("実行の上限に下限がある（0 や負数だと全部「上限に達した」になる）", () => {
    const props = manifest.contributes.configuration.properties;
    expect(props["pli.run.maxSteps"]?.minimum).toBe(1);
    expect(props["pli.run.maxOutputBytes"]?.minimum).toBe(1);
  });

  it("PSB 名は IMS の名前の形だけを受ける（そのままファイル名になる）", () => {
    const pattern = manifest.contributes.configuration.properties["pli.dli.psb"]?.pattern;
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern!);
    expect(re.test("")).toBe(true);
    expect(re.test("STUPSB")).toBe(true);
    expect(re.test("../../etc/x")).toBe(false);
    expect(re.test("TOOLONGNAME")).toBe(false);
  });
});
