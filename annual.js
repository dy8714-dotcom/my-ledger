// 年間の表（I9b）：1月〜12月を横に並べた P/L・試算表（損益）・C/F。印刷は横向き
import { state, loadAllVouchers } from "./state.js?v=0.2I11a";
import { $, esc, yen, showError } from "./util.js?v=0.2I11a";
import { CATEGORIES } from "./seed.js?v=0.2I11a";
import { computeTrial } from "./trial.js?v=0.2I11a";
import { plCalc, bsAt, ASSET_CATS, LIAB_CATS } from "./statements.js?v=0.2I11a";
import { computeCF, CF_ROWS, cashBalance } from "./cashflow.js?v=0.2I11a";

const STAGES = [
  [1, "Ⅰ 事業"], [2, "Ⅱ 給与・その他の収入"], [3, "Ⅲ 税金・社会保険"], [4, "Ⅳ 生活費"], [5, "Ⅴ 評価・特別損益"]
];
const GROUPS = [["op", "営業CF（日々のお金の出入り）", "営業CF 計"], ["inv", "投資CF（証券・仮想通貨・固定資産）", "投資CF 計"], ["fin", "財務CF（借入・返済）", "財務CF 計"]];
const VIEWS = [["pl", "年間P/L"], ["tb", "年間試算表（損益）"], ["cf", "年間C/F"], ["bs", "年間B/S（月末残高）"]];

const num = (n) => (n === 0 ? `<span class="muted">・</span>` : (n < 0 ? "-" : "") + yen(Math.abs(n)));
const yr = () => { if (!state.an) state.an = { year: null, view: "pl", scope: "all" }; if (!state.an.year) state.an.year = parseInt(state.month.split(".")[0], 10); return state.an; };
const mIdx = (y, m) => y * 12 + m; // m = 0..11

export async function renderAnnual() {
  $("view").innerHTML = `<div class="placeholder">1年分を計算しています…</div>`;
  let list;
  try { list = await loadAllVouchers(); }
  catch (err) { showError("仕訳の読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (state.tab !== "annual") return;
  draw(list);
}

// 12か月＋合計の行を作る。vals は 12個の数、total は合計欄（省略時は合計）
function row(label, vals, cls, total, extra) {
  const tot = total === undefined ? vals.reduce((s, x) => s + x, 0) : total;
  return { label, vals, tot, cls: cls || "", extra: extra || "" };
}
const rowHtml = (r) => `<tr class="${r.cls}"><td class="an-l">${r.extra}${esc(r.label)}</td>${r.vals.map((v) => `<td class="r num">${num(v)}</td>`).join("")}<td class="r num an-t">${num(r.tot)}</td></tr>`;
const grpHtml = (t) => `<tr class="grp"><td colspan="14">${esc(t)}</td></tr>`;

function buildPL(list, y, scope) {
  const cols = []; for (let m = 0; m < 12; m++) cols.push(plCalc(list, state.accountsById, mIdx(y, m), mIdx(y, m), scope));
  const rows = [];
  const itemRows = (st, kind) => {
    const ids = new Set(); cols.forEach((c) => Object.keys(c.items[st]).forEach((k) => ids.add(k)));
    const sg = st === 5 && kind === "expense" ? -1 : 1; // 評価・特別損益は、損をマイナスで表す
    return [...ids].map((id) => state.accountsById[id]).filter((a) => a && (!kind || a.kind === kind)).sort((a, b) => a.no - b.no)
      .map((a) => row(`${a.no} ${a.name}`, cols.map((c) => (c.items[st][a.id] ? c.items[st][a.id].amt * sg : 0)), "")).filter((r) => r.vals.some((x) => x));
  };
  const t = (k) => cols.map((c) => c.t[k]);
  rows.push(grpHtml(STAGES[0][1])); rows.push(...itemRows(1, "revenue").map(rowHtml)); rows.push(rowHtml(row("売上 計", t("rev1"), "sub"))); rows.push(...itemRows(1, "expense").map(rowHtml)); rows.push(rowHtml(row("事業の経費 計", t("exp1"), "sub"))); rows.push(rowHtml(row("事業利益", t("p1"), "sub")));
  rows.push(grpHtml(STAGES[1][1])); rows.push(...itemRows(2).map(rowHtml)); rows.push(rowHtml(row("税引前の収入 計（Ⅰ＋Ⅱ）", t("pre"), "sub")));
  rows.push(grpHtml(STAGES[2][1])); rows.push(...itemRows(3).map(rowHtml)); rows.push(rowHtml(row("手取り（税引後）", t("take"), "sub")));
  rows.push(grpHtml(STAGES[3][1])); rows.push(...itemRows(4).map(rowHtml)); rows.push(rowHtml(row("貯蓄・投資に回せた額", t("save"), "sub")));
  rows.push(grpHtml(STAGES[4][1])); rows.push(...itemRows(5, "revenue").map(rowHtml)); rows.push(...itemRows(5, "expense").map(rowHtml)); rows.push(rowHtml(row("当期の純損益", t("net"), "tot")));
  return { rows, csv: null };
}

function buildTB(list, y, scope) {
  const cols = []; for (let m = 0; m < 12; m++) {
    const lst = scope === "all" ? list : list.map((v) => ({ ...v, lines: (v.lines || []).filter((l) => { const a = state.accountsById[l.accId]; return a && (a.kind === "revenue" || a.kind === "expense") && ((l.biz === "biz") === (scope === "biz")); }) }));
    cols.push(computeTrial(lst, state.accountsById, mIdx(y, m), mIdx(y, m)).rows);
  }
  const rows = [];
  let rev = new Array(12).fill(0), exp = new Array(12).fill(0);
  [["revenue", "収益"], ["expense", "経費"]].forEach(([kind, kn]) => {
    rows.push(grpHtml(kn));
    CATEGORIES.forEach((cat) => {
      const accs = Object.values(state.accountsById).filter((a) => a.kind === kind && a.category === cat).sort((a, b) => a.no - b.no);
      const rs = accs.map((a) => row(`${a.no} ${a.name}`, cols.map((c) => (c[a.id] ? c[a.id].bal : 0)))).filter((r) => r.vals.some((x) => x));
      if (!rs.length) return;
      rows.push(`<tr class="grp2"><td colspan="14">${esc(cat)}</td></tr>`);
      rows.push(...rs.map(rowHtml));
      const sums = cols.map((_, i) => rs.reduce((s, r) => s + r.vals[i], 0));
      rows.push(rowHtml(row(cat + " 計", sums, "sub")));
      sums.forEach((v, i) => { if (kind === "revenue") rev[i] += v; else exp[i] += v; });
    });
    rows.push(rowHtml(row(kn + " 合計", kind === "revenue" ? rev : exp, "sub")));
  });
  rows.push(rowHtml(row("収益 − 経費（純損益）", rev.map((v, i) => v - exp[i]), "tot")));
  return { rows };
}

function buildCF(list, y) {
  const res = []; for (let m = 0; m < 12; m++) res.push(computeCF(list, state.accountsById, mIdx(y, m), mIdx(y, m)));
  const end = []; const start = [];
  const prevEnd = cashBalance(list, state.accountsById, mIdx(y, 0) - 1);
  for (let m = 0; m < 12; m++) { end.push(cashBalance(list, state.accountsById, mIdx(y, m))); start.push(m === 0 ? prevEnd : end[m - 1]); }
  const rows = [];
  rows.push(rowHtml(row("月初の現金・預金", start, "sub", start[0])));
  GROUPS.forEach(([g, title, sumLabel]) => {
    rows.push(grpHtml(title));
    CF_ROWS.filter((r) => r.group === g).forEach((r) => {
      const rr = row(r.label, res.map((x) => x.rows[r.key].total));
      if (rr.vals.some((v) => v)) rows.push(rowHtml(rr));
    });
    rows.push(rowHtml(row(sumLabel, res.map((x) => x.g[g]), "sub")));
  });
  rows.push(rowHtml(row("お金の増減（営業＋投資＋財務）", res.map((x) => x.net), "sub")));
  rows.push(rowHtml(row("開始残高の登録（元入金の仕訳）", res.map((x) => x.opening))));
  rows.push(rowHtml(row("月末の現金・預金", end, "tot", end[11])));
  const diff = res.map((x, i) => start[i] + x.net + x.opening - end[i]);
  const ok = diff.every((d) => d === 0);
  rows.push(`<tr class="${ok ? "sub" : "tot"}"><td class="an-l">残高の突き合わせ（月初＋増減＋開始残高−月末）</td><td colspan="13" class="r">${ok ? "毎月 一致 ✓" : "合わない月があります：" + diff.map((d, i) => d ? `${i + 1}月 ${yen(d)}` : "").filter(Boolean).join("、")}</td></tr>`);
  return { rows };
}

function buildBS(list, y) {
  const bs = []; for (let m = 0; m < 12; m++) bs.push(bsAt(list, state.accountsById, mIdx(y, m)));
  const accs = state.accounts.filter((a) => !a.hidden);
  const rows = [];
  const last = (r) => ({ ...r, tot: r.vals[11] });
  const mk = (label, f, cls) => last(row(label, bs.map(f), cls));
  const items = (cat, kind) => accs.filter((a) => a.category === cat && a.kind === kind).sort((p, q) => p.no - q.no)
    .map((a) => last(row(`${a.no} ${a.name}`, bs.map((b) => b.bal[a.id] || 0)))).filter((r) => r.vals.some((v) => v));
  const part = (cats, kind) => cats.forEach((cat) => {
    const rs = items(cat, kind); if (!rs.length) return;
    rows.push(grpHtml(cat)); rows.push(...rs.map(rowHtml));
    rows.push(rowHtml(last(row(cat + " 計", bs.map((_, i) => rs.reduce((s, r) => s + r.vals[i], 0)), "sub"))));
  });
  part(ASSET_CATS, "asset"); rows.push(rowHtml(mk("資産 合計", (b) => b.A, "tot")));
  part(LIAB_CATS, "liability"); rows.push(rowHtml(mk("負債 合計", (b) => b.L, "tot")));
  rows.push(grpHtml("純資産"));
  accs.filter((a) => a.kind === "equity").sort((p, q) => p.no - q.no).forEach((a) => {
    const sg = a.no === 91 ? -1 : 1; const r = last(row(`${a.no} ${a.name}`, bs.map((b) => (b.bal[a.id] || 0) * sg)));
    if (r.vals.some((v) => v)) rows.push(rowHtml(r));
  });
  rows.push(rowHtml(mk("前期までの損益（繰越）", (b) => b.prev)));
  rows.push(rowHtml(mk("当期純損益（その年の1月〜）", (b) => b.cur)));
  rows.push(rowHtml(mk("純資産 合計", (b) => b.eq, "tot")));
  rows.push(rowHtml(mk("負債 ＋ 純資産 合計", (b) => b.L + b.eq, "tot")));
  const ok = bs.every((b) => b.gap === 0);
  rows.push(`<tr class="${ok ? "sub" : "tot"}"><td class="an-l">資産 − 負債 − 純資産</td><td colspan="13" class="r">${ok ? "毎月 一致 ✓" : "合わない月：" + bs.map((b, i) => b.gap ? `${i + 1}月 ${yen(b.gap)}` : "").filter(Boolean).join("、")}</td></tr>`);
  return { rows };
}

function draw(list) {
  const a = yr();
  const y = a.year;
  const built = a.view === "pl" ? buildPL(list, y, a.scope) : a.view === "tb" ? buildTB(list, y, a.scope) : a.view === "cf" ? buildCF(list, y) : buildBS(list, y);
  const scoped = a.view === "pl" || a.view === "tb";
  const title = VIEWS.find((v) => v[0] === a.view)[1];
  $("view").innerHTML = `
    <div class="monthbar">
      <button type="button" class="navbtn" id="an-prev" aria-label="前の年">◀</button>
      <h2 id="an-title" style="min-width:150px">${2000 + y}年 ${esc(title)}</h2>
      <button type="button" class="navbtn" id="an-next" aria-label="次の年">▶</button>
      <span class="spacer"></span>
      <div class="seg" id="an-view">${VIEWS.map(([k, n]) => `<button type="button" data-v="${k}" class="${a.view === k ? "on" : ""}">${n}</button>`).join("")}</div>
      ${scoped ? `<div class="seg" id="an-scope">${[["all", "全体"], ["biz", "事業だけ"], ["life", "生活だけ"]].map(([k, n]) => `<button type="button" data-s="${k}" class="${a.scope === k ? "on" : ""}">${n}</button>`).join("")}</div>` : ""}
      <button type="button" class="sub" id="an-csv">CSV</button>
      <button type="button" class="sub" id="an-print">印刷（横向き）</button>
    </div>
    <section class="panel nopad"><div class="tablewrap"><table class="tbl an">
      <thead><tr><th class="an-l">${esc(title)}</th>${Array.from({ length: 12 }, (_, i) => `<th class="r">${i + 1}月</th>`).join("")}<th class="r">${a.view === "cf" ? "年 合計" : a.view === "bs" ? "年末" : "合計"}</th></tr></thead>
      <tbody>${built.rows.join("")}</tbody></table></div></section>
    <p class="note">${a.view === "bs" ? "各月の月末時点の残高です。右端の「年末」は12月末の残高です。" : a.view === "cf" ? "月末の現金・預金の「合計」欄は、その年の12月末の残高です。" : "金額は、収益はプラス・経費もプラスで表します（P/Lの見方と同じです）。"}　数字がない（・）月は動きがありません。</p>`;
  $("view").dataset.orient = "landscape";
  $("an-prev").addEventListener("click", () => { a.year--; draw(list); });
  $("an-next").addEventListener("click", () => { a.year++; draw(list); });
  $("an-view").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) { a.view = b.dataset.v; draw(list); } });
  if (scoped) $("an-scope").addEventListener("click", (e) => { const b = e.target.closest("button[data-s]"); if (b) { a.scope = b.dataset.s; draw(list); } });
  $("an-print").addEventListener("click", () => window.print());
  $("an-csv").addEventListener("click", () => {
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const out = [[title, ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), "合計"].map(q).join(",")];
    document.querySelectorAll(".tbl.an tbody tr").forEach((tr) => {
      if (tr.classList.contains("grp") || tr.classList.contains("grp2")) { out.push(q(tr.textContent.trim())); return; }
      const tds = [...tr.children].map((c) => c.textContent.trim().replace(/,/g, "").replace("・", "0"));
      out.push(tds.map((x, i) => (i === 0 ? q(x) : x)).join(","));
    });
    const blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const l = document.createElement("a");
    l.href = URL.createObjectURL(blob);
    l.download = `年間_${title}_${2000 + y}.csv`;
    document.body.appendChild(l); l.click(); l.remove();
  });
}
