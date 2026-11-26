// B/S（貸借対照表）と P/L（損益計算書）。月ごとに、前月・昨年の同じ月・好きな月と比べられる
import { state, loadAllVouchers } from "./state.js?v=0.2I11b";
import { $, esc, yen, accChip, shiftMonth, showError } from "./util.js?v=0.2I11b";
import { computeTrial, equityParts } from "./trial.js?v=0.2I11b";

const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
export const keyOf = (idx) => String(Math.floor(idx / 12)).padStart(2, "0") + "." + ((idx % 12) + 1);
const labelOf = (idx) => `${2000 + Math.floor(idx / 12)}年${(idx % 12) + 1}月`;
const ym = (idx) => `${2000 + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
const fromYm = (v) => keyOf((parseInt(v.slice(0, 4), 10) - 2000) * 12 + parseInt(v.slice(5, 7), 10) - 1);

const num = (n) => (n === 0 ? `<span class="muted">0</span>` : yen(n));
const dif = (n) => (n === 0 ? `<span class="muted">0</span>` : (n > 0 ? "+" : "-") + yen(Math.abs(n)));
const link = (accId, fromM, toM, html) => `<a href="#" class="lk" data-acc="${esc(accId)}" data-from="${fromM}" data-to="${toM}">${html}</a>`;

// 比べる月を決める（"26.11" → 前月 "26.10"、昨年の同じ月 "25.11"、好きな月）
export function compareMonth(month, st) {
  if (st.cmp === "lastyear") return shiftMonth(month, -12);
  if (st.cmp === "custom" && st.cmpMonth) return st.cmpMonth;
  return shiftMonth(month, -1);
}

// ---------- B/S ----------
export const ASSET_CATS = ["現金・預金", "その他流動資産", "金融資産", "固定資産"];
export const LIAB_CATS = ["流動負債", "固定負債"];

// X月末の残高（資産・負債・純資産）
export function bsAt(list, accountsById, X) {
  const { rows, pl } = computeTrial(list, accountsById, X, X);
  const bal = {};
  Object.values(rows).forEach((r) => { bal[r.a.id] = r.bal; });
  const eqp = equityParts(pl, X);
  let A = 0, L = 0, Q = 0;
  Object.values(rows).forEach((r) => {
    if (r.a.kind === "asset") A += r.bal;
    else if (r.a.kind === "liability") L += r.bal;
    else if (r.a.kind === "equity") Q += r.a.no === 91 ? -r.bal : r.bal; // 事業主貸は純資産を減らす
  });
  const eq = Q + eqp.prev + eqp.cur;
  return { bal, prev: eqp.prev, cur: eqp.cur, A, L, Q, eq, gap: A - L - eq };
}

// ---------- P/L ----------
// 仕訳の明細ごとに、どの段階に入れるかを決める
export function stageOf(a, line) {
  if (a.category === "評価・特別損益") return 5;
  if (a.category === "税金・社会保険") return 3;
  if (a.kind === "revenue") return a.no === 48 || line.biz === "biz" ? 1 : 2;
  if (a.kind === "expense") return line.biz === "biz" ? 1 : 4;
  return 0;
}

// S〜E月の損益。scope: all / biz / life。戻り値 items[段階][accId]= {a, rev, exp}（rev・exp は自然な向きの金額）
export function plCalc(list, accountsById, S, E, scope) {
  const items = { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
  list.forEach((v) => {
    const mi = idxOf(v.month);
    if (mi < S || mi > E) return;
    (v.lines || []).forEach((l) => {
      const a = accountsById[l.accId];
      if (!a || (a.kind !== "revenue" && a.kind !== "expense")) return;
      const isBiz = a.no === 48 || l.biz === "biz";
      if (scope === "biz" && !isBiz) return;
      if (scope === "life" && isBiz) return;
      const st = stageOf(a, l);
      if (!st) return;
      const it = items[st][a.id] || (items[st][a.id] = { a, amt: 0 });
      const dr = l.side === "debit" ? l.amount : -l.amount;
      // 収益は 貸方−借方、費用は 借方−貸方 を「金額」とする
      it.amt += a.kind === "revenue" ? -dr : dr;
    });
  });
  const sum = (st, kind) => Object.values(items[st]).filter((x) => !kind || x.a.kind === kind).reduce((s, x) => s + x.amt, 0);
  const t = {};
  t.rev1 = sum(1, "revenue"); t.exp1 = sum(1, "expense"); t.p1 = t.rev1 - t.exp1;
  t.in2 = sum(2); t.pre = t.p1 + t.in2;
  t.tax = sum(3); t.take = t.pre - t.tax;
  t.life = sum(4); t.save = t.take - t.life;
  t.v5 = sum(5, "revenue") - sum(5, "expense");
  t.net = t.save + t.v5;
  return { items, t };
}

// ---------- 画面 ----------
function stOf() {
  if (!state.st) state.st = { month: null, cmp: "prev", cmpMonth: null, scope: "all" };
  if (!state.st.month) state.st.month = state.month;
  return state.st;
}

function bar(kind, st, X, Y, extra) {
  const cmpOpts = [["prev", "前月"], ["lastyear", "昨年の同じ月"], ["custom", "好きな月"]];
  return `<div class="monthbar">
      <button type="button" class="navbtn" id="st-prev" aria-label="前の月">◀</button>
      <h2 id="st-title" style="min-width:190px">${esc(labelOf(X))}${kind === "bs" ? "末" : ""}</h2>
      <button type="button" class="navbtn" id="st-next" aria-label="次の月">▶</button>
      <span class="note">${kind === "bs" ? "貸借対照表（B/S）" : "損益計算書（P/L）"}</span>
      <span class="spacer"></span>
      <span class="note">比べる月：</span>
      <div class="seg" id="st-cmp">${cmpOpts.map(([k, n]) => `<button type="button" data-cmp="${k}" class="${st.cmp === k ? "on" : ""}">${n}</button>`).join("")}</div>
      ${st.cmp === "custom" ? `<input type="month" id="st-cmpm" value="${ym(idxOf(Y))}">` : `<span class="note">（${esc(labelOf(idxOf(Y)))}）</span>`}
      ${extra || ""}
      <button type="button" class="sub" id="st-csv">CSV</button>
      <button type="button" class="sub" id="st-print">印刷</button>
    </div>`;
}

function wire(kind, list, redraw, csvLines, fileBase) {
  const st = stOf();
  $("st-prev").addEventListener("click", () => { st.month = shiftMonth(st.month, -1); redraw(); });
  $("st-next").addEventListener("click", () => { st.month = shiftMonth(st.month, 1); redraw(); });
  $("st-cmp").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cmp]");
    if (!b) return;
    st.cmp = b.dataset.cmp;
    if (st.cmp === "custom" && !st.cmpMonth) st.cmpMonth = shiftMonth(st.month, -1);
    redraw();
  });
  const cm = $("st-cmpm");
  if (cm) cm.addEventListener("change", (e) => { if (e.target.value) { st.cmpMonth = fromYm(e.target.value); redraw(); } });
  $("st-print").addEventListener("click", () => window.print());
  $("st-csv").addEventListener("click", () => {
    const blob = new Blob(["﻿" + csvLines().join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileBase}_${ym(idxOf(st.month))}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("view").onclick = (e) => {
    const a = e.target.closest("a.lk");
    if (!a) return;
    e.preventDefault();
    state.lg = state.lg || { cond: null, mode: "none" };
    state.lg.preset = { accountId: a.dataset.acc, side: "both", fromM: a.dataset.from, toM: a.dataset.to };
    state.tab = "ledger";
    document.querySelector('#nav [data-tab="ledger"]').click();
  };
}

const q = (x) => `"${String(x).replace(/"/g, '""')}"`;

async function load(tab) {
  $("view").innerHTML = `<div class="placeholder">計算しています…</div>`;
  let list;
  try { list = await loadAllVouchers(); }
  catch (err) { showError("仕訳の読み込みに失敗しました：" + (err.code || err.message)); return null; }
  if (state.tab !== tab) return null;
  return list;
}

// ===== B/S =====
export async function renderBS() {
  const list = await load("bs");
  if (list) drawBS(list);
}

function drawBS(list) {
  const st = stOf();
  const X = idxOf(st.month), Yk = compareMonth(st.month, st), Y = idxOf(Yk);
  const c = bsAt(list, state.accountsById, X), p = bsAt(list, state.accountsById, Y);
  const accs = state.accounts.filter((a) => !a.hidden);
  const inCat = (cat, kind) => accs.filter((a) => a.category === cat && a.kind === kind).sort((x, y) => x.no - y.no)
    .filter((a) => (c.bal[a.id] || 0) !== 0 || (p.bal[a.id] || 0) !== 0);

  const cg = `<colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup>`;
  const head = cg + `<thead><tr><th>科目</th><th class="r">${esc(labelOf(X))}末</th><th class="r">${esc(labelOf(Y))}末</th><th class="r">増減</th></tr></thead>`;
  const row = (a, sign) => {
    const cv = (c.bal[a.id] || 0) * sign, pv = (p.bal[a.id] || 0) * sign;
    return `<tr><td>${link(a.id, "20.1", keyOf(X), accChip(a))}</td><td class="r num">${num(cv)}</td><td class="r num muted2">${num(pv)}</td><td class="r num">${dif(cv - pv)}</td></tr>`;
  };
  const subRow = (name, cv, pv, cls) => `<tr class="${cls || "sub"}"><td>${esc(name)}</td><td class="r num">${yen(cv)}</td><td class="r num">${yen(pv)}</td><td class="r num">${dif(cv - pv)}</td></tr>`;
  const catSum = (cat, kind, sign, by) => inCat(cat, kind).reduce((s, a) => s + (by.bal[a.id] || 0) * sign, 0);

  let left = "";
  ASSET_CATS.forEach((cat) => {
    const rs = inCat(cat, "asset");
    if (!rs.length) return;
    left += `<tr class="grp"><td colspan="4">${esc(cat)}</td></tr>` + rs.map((a) => row(a, 1)).join("") + subRow(cat + " 計", catSum(cat, "asset", 1, c), catSum(cat, "asset", 1, p));
  });
  left += subRow("資産 合計", c.A, p.A, "tot");

  let right = "";
  LIAB_CATS.forEach((cat) => {
    const rs = inCat(cat, "liability");
    if (!rs.length) return;
    right += `<tr class="grp"><td colspan="4">${esc(cat)}</td></tr>` + rs.map((a) => row(a, 1)).join("") + subRow(cat + " 計", catSum(cat, "liability", 1, c), catSum(cat, "liability", 1, p));
  });
  right += subRow("負債 合計", c.L, p.L, "tot");
  let eqPart = "";
  const eqAccs = accs.filter((a) => a.kind === "equity").sort((x, y) => x.no - y.no).filter((a) => (c.bal[a.id] || 0) !== 0 || (p.bal[a.id] || 0) !== 0);
  eqPart += `<tr class="grp"><td colspan="4">純資産</td></tr>` + eqAccs.map((a) => row(a, a.no === 91 ? -1 : 1)).join("") +
    subRow("前期までの損益（繰越）", c.prev, p.prev, "") + subRow("当期純損益（その年の1月〜）", c.cur, p.cur, "") +
    subRow("純資産 合計", c.eq, p.eq, "tot");
  eqPart += subRow("負債 ＋ 純資産 合計", c.L + c.eq, p.L + p.eq, "tot");

  const okC = c.gap === 0, okP = p.gap === 0;
  const check = `<div class="${okC && okP ? "okbadge" : "warnbadge"}" id="bs-check">資産 − 負債 − 純資産：${esc(labelOf(X))}末 ${yen(c.gap)} ${okC ? "✓" : "✗"}　${esc(labelOf(Y))}末 ${yen(p.gap)} ${okP ? "✓" : "✗"}</div>`;

  $("view").innerHTML = bar("bs", st, X, Yk) + `<div class="note" style="margin:-4px 0 10px">${check}</div>
    <div class="stgrid">
      <section class="panel nopad"><div class="panel-head"><h3><span class="bar"></span>資産</h3></div><div class="tablewrap"><table class="tbl tb st">${head}<tbody>${left}</tbody></table></div></section>
      <section class="panel nopad"><div class="panel-head"><h3><span class="bar"></span>負債と純資産</h3></div><div class="tablewrap"><table class="tbl tb st">${head}<tbody>${right}</tbody></table><table class="tbl tb st eq">${cg}<tbody>${eqPart}</tbody></table></div></section>
    </div>`;

  wire("bs", list, () => drawBS(list), () => {
    const L = [["区分", "番号", "科目", `${labelOf(X)}末`, `${labelOf(Y)}末`, "増減"].map(q).join(",")];
    accs.filter((a) => ["asset", "liability", "equity"].includes(a.kind)).sort((x, y) => x.no - y.no).forEach((a) => {
      const sg = a.no === 91 ? -1 : 1, cv = (c.bal[a.id] || 0) * sg, pv = (p.bal[a.id] || 0) * sg;
      if (cv || pv) L.push([q(a.category), a.no, q(a.name), cv, pv, cv - pv].join(","));
    });
    L.push([q("純資産"), "", q("前期までの損益（繰越）"), c.prev, p.prev, c.prev - p.prev].join(","));
    L.push([q("純資産"), "", q("当期純損益"), c.cur, p.cur, c.cur - p.cur].join(","));
    L.push([q("合計"), "", q("資産"), c.A, p.A, c.A - p.A].join(","), [q("合計"), "", q("負債"), c.L, p.L, c.L - p.L].join(","), [q("合計"), "", q("純資産"), c.eq, p.eq, c.eq - p.eq].join(","));
    return L;
  }, "B-S");
}

// ===== P/L =====
export async function renderPL() {
  const list = await load("pl");
  if (list) drawPL(list);
}

const STAGES = [
  [1, "Ⅰ 事業", "売上 − 事業の経費"],
  [2, "Ⅱ 給与・その他の収入", ""],
  [3, "Ⅲ 税金・社会保険", ""],
  [4, "Ⅳ 生活費", "事業以外の経費"],
  [5, "Ⅴ 評価・特別損益", "評価益はプラス、評価損はマイナス"]
];

export function plColumns(list, accountsById, st) {
  const X = idxOf(st.month), Y = idxOf(compareMonth(st.month, st));
  const y0 = X - (X % 12);
  return [plCalc(list, accountsById, X, X, st.scope), plCalc(list, accountsById, Y, Y, st.scope), plCalc(list, accountsById, y0, X, st.scope)];
}

function drawPL(list) {
  const st = stOf();
  const X = idxOf(st.month), Yk = compareMonth(st.month, st), Y = idxOf(Yk), y0 = X - (X % 12);
  const cols = plColumns(list, state.accountsById, st); // [当月, 比較月, 今年の累計]
  const scopes = [["all", "全体"], ["biz", "事業だけ"], ["life", "生活だけ"]];

  const cell = (n, bold) => `<td class="r num"${bold ? ' style="font-weight:700"' : ""}>${num(n)}</td>`;
  const mk = (label, f, cls, withDiff = true) => {
    const [c, p, t] = cols.map(f);
    return `<tr class="${cls}"><td>${esc(label)}</td>${cell(c, 1)}<td class="r num muted2">${num(p)}</td><td class="r num">${withDiff ? dif(c - p) : ""}</td>${cell(t)}</tr>`;
  };
  const itemRows = (stg) => {
    const ids = new Set();
    cols.forEach((cl) => Object.keys(cl.items[stg]).forEach((k) => ids.add(k)));
    return [...ids].map((id) => state.accountsById[id]).sort((a, b) => a.no - b.no).map((a) => {
      const sg = stg === 5 && a.kind === "expense" ? -1 : 1;
      const v = cols.map((cl) => ((cl.items[stg][a.id] || {}).amt || 0) * sg);
      if (!v[0] && !v[1] && !v[2]) return "";
      const lk = (html) => link(a.id, keyOf(X), keyOf(X), html);
      return `<tr><td>${lk(accChip(a))}</td><td class="r num">${num(v[0])}</td><td class="r num muted2">${num(v[1])}</td><td class="r num">${dif(v[0] - v[1])}</td><td class="r num">${link(a.id, keyOf(y0), keyOf(X), num(v[2]))}</td></tr>`;
    }).join("");
  };
  const grp = (stg, name, note) => `<tr class="grp"><td colspan="5">${esc(name)}${note ? ` <span class="note">${esc(note)}</span>` : ""}</td></tr>`;

  let body = "";
  // Ⅰ
  body += grp(...STAGES[0]) + itemRows(1) + mk("事業利益", (c) => c.t.p1, "sub");
  // Ⅱ
  body += grp(...STAGES[1]) + itemRows(2) + mk("税引前の収入 計（Ⅰ＋Ⅱ）", (c) => c.t.pre, "sub");
  // Ⅲ
  body += grp(...STAGES[2]) + itemRows(3) + mk("手取り（Ⅰ＋Ⅱ−Ⅲ）", (c) => c.t.take, "sub");
  // Ⅳ
  body += grp(...STAGES[3]) + itemRows(4) + mk("生活費 計", (c) => c.t.life, "sub") + mk("貯蓄に回せる額（手取り−生活費）", (c) => c.t.save, "sub");
  // Ⅴ
  body += grp(...STAGES[4]) + itemRows(5) + mk("評価・特別損益 計", (c) => c.t.v5, "sub");
  body += mk("当期純損益（B/Sの純資産へ）", (c) => c.t.net, "tot");

  // 試算表と同じ数字になるか確かめる（全体のときだけ）
  let chk = "";
  if (st.scope === "all") {
    const { pl } = computeTrial(list, state.accountsById, X, X);
    const tbNet = pl[X] || 0;
    const ytd = Object.keys(pl).reduce((s, k) => (+k >= y0 && +k <= X ? s + pl[k] : s), 0);
    const ok = tbNet === cols[0].t.net && ytd === cols[2].t.net;
    chk = `<span class="${ok ? "okbadge" : "warnbadge"}" id="pl-check">試算表の損益と ${ok ? "一致 ✓" : "合いません ✗"}</span>`;
  }
  const scopeSeg = `<div class="seg" id="st-scope">${scopes.map(([k, n]) => `<button type="button" data-scope="${k}" class="${st.scope === k ? "on" : ""}">${n}</button>`).join("")}</div>`;

  $("view").innerHTML = bar("pl", st, X, Yk, scopeSeg + chk) + `
    <section class="panel nopad"><div class="tablewrap"><table class="tbl tb st plt">
      <thead><tr><th>項目</th><th class="r">${esc(labelOf(X))}</th><th class="r">${esc(labelOf(Y))}</th><th class="r">増減</th><th class="r">${2000 + Math.floor(X / 12)}年の累計（1月〜${(X % 12) + 1}月）</th></tr></thead>
      <tbody>${body}</tbody></table></div></section>
    <div class="note" style="margin-top:8px">事業の経費＝仕訳の「事業」印が付いた経費。生活費＝それ以外の経費。金額をクリックすると元帳に移ります。</div>`;

  $("st-scope").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-scope]");
    if (!b) return;
    st.scope = b.dataset.scope;
    drawPL(list);
  });
  wire("pl", list, () => drawPL(list), () => {
    const L = [["段階", "科目", labelOf(X), labelOf(Y), "増減", "今年の累計"].map(q).join(",")];
    STAGES.forEach(([stg, name]) => {
      const ids = new Set();
      cols.forEach((cl) => Object.keys(cl.items[stg]).forEach((k) => ids.add(k)));
      [...ids].map((id) => state.accountsById[id]).sort((a, b) => a.no - b.no).forEach((a) => {
        const sg = stg === 5 && a.kind === "expense" ? -1 : 1;
        const v = cols.map((cl) => ((cl.items[stg][a.id] || {}).amt || 0) * sg);
        if (v[0] || v[1] || v[2]) L.push([q(name), q(a.no + " " + a.name), v[0], v[1], v[0] - v[1], v[2]].join(","));
      });
    });
    [["事業利益", "p1"], ["税引前の収入", "pre"], ["手取り", "take"], ["生活費", "life"], ["貯蓄に回せる額", "save"], ["評価・特別損益", "v5"], ["当期純損益", "net"]]
      .forEach(([n, k]) => L.push([q("小計"), q(n), cols[0].t[k], cols[1].t[k], cols[0].t[k] - cols[1].t[k], cols[2].t[k]].join(",")));
    return L;
  }, "P-L");
}
