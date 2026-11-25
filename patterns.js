// 取引先ごとの「入力パターン」（科目の組み合わせ）の道具
import { state } from "./state.js?v=0.1D3";

// 行の組み合わせを表す印（金額・摘要は見ない）
export function sigOf(lines) {
  return lines.map((l) => l.side[0] + l.accId).sort().join("|");
}

// その取引先のパターン一覧。古い形（last）しかなければ、1つのパターンに読み替える
export function patternsOf(p) {
  if (p.patterns && p.patterns.length) return p.patterns;
  const l = p.last;
  if (l && l.debitId && l.creditId) {
    const lines = [
      { side: "debit", accId: l.debitId, tax: l.tax || 0 },
      { side: "credit", accId: l.creditId, tax: l.tax || 0 }
    ];
    return [{ sig: sigOf(lines), lines, uses: p.count || 1, last: p.lastUsed || "", legacy: true }];
  }
  return [];
}

// よく使う順（回数 → 最近）
export function sortPatterns(list) {
  return [...list].sort((a, b) =>
    (b.uses || 0) - (a.uses || 0) || String(b.last || "").localeCompare(String(a.last || "")));
}

export function describePattern(pat) {
  const nm = (id) => (state.accountsById[id] ? state.accountsById[id].name : "（不明な科目）");
  const side = (s) => pat.lines.filter((l) => l.side === s)
    .map((l) => nm(l.accId) + (l.tax ? `(${l.tax}%)` : "")).join("＋");
  return `借方 ${side("debit")} ／ 貸方 ${side("credit")}`;
}

// 保存用に、パターンの一覧へ1つ足す（同じ形なら回数を増やす）。最大8件
export function addPattern(list, lines, date) {
  const sig = sigOf(lines);
  const slim = lines.map((l) => ({ side: l.side, accId: l.accId, tax: l.tax || 0 }));
  const out = list.map((x) => ({ sig: x.sig, lines: x.lines, uses: x.uses || 0, last: x.last || "" }));
  const hit = out.find((x) => x.sig === sig);
  if (hit) { hit.uses += 1; hit.last = date; hit.lines = slim; }
  else out.push({ sig, lines: slim, uses: 1, last: date });
  return sortPatterns(out).slice(0, 8);
}
