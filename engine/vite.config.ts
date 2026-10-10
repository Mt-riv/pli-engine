import { defineConfig, type Plugin } from "vite";

/**
 * ビルド結果を1枚の HTML に畳む。
 *
 * ローカルで配る前提なので、ファイルをダブルクリックするだけで
 * 開けることを優先する。外部ファイルを `<script type="module" src=...>`
 * で読む形だと file:// では CORS で弾かれて動かないため、
 * 出力を IIFE にしたうえで HTML に直接埋め込む。
 */
function singleFile(): Plugin {
  return {
    name: "pli-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (f) => f.type === "asset" && f.fileName.endsWith(".html"),
      );
      if (!html || html.type !== "asset") return;

      let source = String(html.source);

      // JS を埋め込む（IIFE なので classic script として読める）。
      //
      // 置き場所が重要: Vite は script を <head> に注入するが、
      // module と違いインラインの classic script は遅延しないため、
      // <head> に置くと DOM 生成前に走って要素が見つからない。
      // 元のタグは取り除き、</body> の直前に入れ直す。
      const scripts: string[] = [];
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        const tag = new RegExp(
          `<script[^>]*src="[^"]*${chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*></script>`,
        );
        source = source.replace(tag, "");
        // JSON 内の </script> がタグを閉じてしまわないように退避する
        scripts.push(chunk.code.replace(/<\/script>/gi, "<\\/script>"));
        delete bundle[name];
      }
      if (scripts.length > 0) {
        const block = scripts.map((c) => `<script>\n${c}\n</script>`).join("\n");
        source = source.includes("</body>")
          ? source.replace("</body>", `${block}\n</body>`)
          : source + block;
      }

      // CSS を埋め込む
      for (const [name, asset] of Object.entries(bundle)) {
        if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
        const tag = new RegExp(
          `<link[^>]*href="[^"]*${asset.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
        );
        source = source.replace(tag, `<style>\n${String(asset.source)}\n</style>`);
        delete bundle[name];
      }

      html.source = source;
    },
  };
}

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [singleFile()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    target: "es2022",
    // file:// で動かすため ESM ではなく IIFE にする。
    // IIFE は分割できないので、`inlineDynamicImports` は書かない
    // （書くと Vite 8 が「codeSplitting: false なので無視する」と警告する）
    rollupOptions: { output: { format: "iife" } },
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  server: { port: 5173 },
});
