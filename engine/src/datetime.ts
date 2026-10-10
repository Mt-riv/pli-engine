/**
 * 日付の計算。
 *
 * MFS のシステム定数（`DATE1`）と入出力 PCB の日付（`yyddd`）が
 * 同じ通日を使うので、式を 1 箇所に置く。2 箇所に書いていたときは
 * 片方だけが夏時間で 1 日ずれ、**同じ画面の `DATE1` と `DATE2` が
 * 食い違う**という内部矛盾になっていた。
 */

/**
 * 1 月 1 日を 1 とする通日。
 *
 * 経過ミリ秒の床で求めてはいけない。夏時間のある地域では
 * 1 時間ぶん足りず、0 時台の時刻で前日になる
 * （`TZ=America/New_York` の 2026-10-10 00:30 で 282。正しくは 283）。
 * 暦の日付から求めれば時刻と時間帯に依らない。
 */
export function dayOfYear(d: Date): number {
  const ms =
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
    Date.UTC(d.getFullYear(), 0, 1);
  return Math.round(ms / 86400000) + 1;
}
