/** 画面のゴールデンを作り直す道具（確認したうえで置くこと）。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHost, loadMfs } from "./src/index.js";
import { parseKeys, playKeys, transcript } from "./src/tm/keys.js";
import { parseFiles, psbNames } from "./web/files.js";

const DIR = join(import.meta.dirname, "test", "screen");
for (const name of process.argv.slice(2)) {
  const read = (ext: string): string => readFileSync(join(DIR, `${name}.${ext}`), "utf8");
  const files = parseFiles(read("files"));
  const { steps } = playKeys({
    source: read("pli"),
    library: loadMfs({ [`${name}.mfs`]: read("mfs") }),
    host: new MemoryHost(files),
    psb: psbNames(files)[0]!,
    script: parseKeys(read("keys"), `${name}.keys`),
    limits: { maxSteps: 1_000_000, maxOutputBytes: 100_000 },
  });
  const text = transcript(steps);
  writeFileSync(join(DIR, `${name}.screen`), text);
  process.stdout.write(text);
}
