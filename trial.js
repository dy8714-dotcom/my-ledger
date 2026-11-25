// 試算表（科目ごとの 月初残高・借方・貸方・残高）
import { state, loadAllVouchers } from "./state.js?v=0.1F2";
import { $, esc, yen, accChip, shiftMonth, showError } from "./util.js?v=0.1F2";
import { CATEGORIES } from "./seed.js?v=0.1F2";

// "26.11" → 通し番号（月ごとに +1）
const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
const keyOf = (idx) => String(Math.floor(idx / 12)).padStart(2, "0") + "." + ((idx % 12) + 1);
const labelOf = (idx) => `${2000 + Math.floor(idx / 12)}年${(idx % 12) + 1}月`;
const isBS = (a) => a.kind === "asset" || a.kind === "liability" || a.kind === "equity";

// 期間（通し番号の from〜to）を決める
function periodOf() {
  const t = state.tb;
  const cur = idxOf(t.month);
  if (t.mode === "quarter") { const s = cur - (cur % 12) + Math.floor((cur % 12) / 3) * 3; return [s, s + 2]; }
  if (t.mode === "year") return [cur - (cur % 12), cur];
  if (t.mode === "custom") {
    const a = t.from ? idxOf(t.from) : cur, b = t.to ? idxOf(t.to) : cur;
    return a <= b ? [a, b] : [b, a];
  }
  return [cur, cur];
}

function periodTitle(S, E) {
  const t = state.tb;
  if (t.mode === "month") return `${labelOf(S)}度`;
  if (t.mode === "quarter") return `${labelOf(S)}〜${(E % 12) + 1}月`;
  if (t.mode === "year") return `${labelOf(S)}〜${(E % 12) + 1}月（累計）`;
  return `${labelOf(S)}〜${labelOf(E)}`;
}

// 計算。rows: 科目ごとの {open, dr, cr, bal}
export function computeTrial(vouchers, accountsById, S, E) {
  const rows = {};
  const get = (a) => rows[a.id] || (rows[a.id] = { a, raw: 0, dr: 0, cr: 0 });
  let allDr = 0, allCr = 0;
  vouchers.forEach((v) => {
    const mi = idxOf(v.month);
    if (mi > E) return;
    (v.lines || []).forEach((l) => {
      allDr += l.side === "debit" ? l.amount : 0;
      allCr += l.side === "credit" ? l.amount : 0;
      const a = accountsById[l.accId];
      if (!a) return;
      const r = get(a);
      if (mi < S) { if (isBS(a)) r.raw += l.side === "debit" ? l.amount : -l.amount; }
      else if (l.side === "debit") r.dr += l.amount; else r.cr += l.amount;
    });
  });
  const out = {};
  Object.values(rows).forEach((r) => {
    const sign = r.a.side === "credit" ? -1 : 1;
    const open = r.raw * sign;
    const bal = open + (r.dr - r.cr) * sign;
    out[r.a.id] = { a: r.a, open, dr: r.dr, cr: r.cr, bal, diff: bal - open };
  });
  return { rows: out, allDr, allCr };
}

const num = (n) => (n === 0 ? `<span class="muted">0</span>` : yen(n));
const link = (accId, side, html) => `<a href="#" class="lk" data-acc="${esc(accId)}" data-side="${side}">${html}</a>`;
const diffHtml = (n) => (n === 0 ? `<span class="muted">0</span>` : `<span class="${n > 0 ? "inc" : "out"}">${n > 0 ? "+" : "-"}${yen(Math.abs(n))}</span>`);

export async function renderTrial() {
  const t = state.tb;
  if (!t.month) t.month = state.month;
  $("view").innerHTML = `<div class="placeholder">試算表を計算しています…</div>`;
  let list;
  try { list = await loadAllVouchers(); }
  catch (err) { showError("仕訳の読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (state.tab !== "trial") return;
  draw(list);
}

function draw(list) {
  const t = state.tb;
  const [S, E] = periodOf();
  const { rows, allDr, allCr } = computeTrial(list, state.accountsById, S, E);
  const all = Object.values(rows);
  const visible = (r) => !t.hideZero || r.open || r.dr || r.cr || r.bal;
  const periodDr = all.reduce((s, r) => s + r.dr, 0);
  const periodCr = all.reduce((s, r) => s + r.cr, 0);
  const okAll = periodDr === periodCr && allDr === allCr;

  // 表の行
  let body = "";
  let alt = 0;
  const rowHtml = (r) => `<tr class="${alt++ % 2 ? "alt" : ""}">
      <td>${link(r.a.id, "both", accChip(r.a))}</td><td class="r num">${num(r.open)}</td><td class="r num">${link(r.a.id, "debit", num(r.dr))}</td><td class="r num">${link(r.a.id, "credit", num(r.cr))}</td>
      <td class="r num" style="font-weight:700">${link(r.a.id, "both", num(r.bal))}</td><td class="r num">${diffHtml(r.diff)}</td></tr>`;
  const sum = (rs) => rs.reduce((s, r) => ({ open: s.open + r.open, dr: s.dr + r.dr, cr: s.cr + r.cr, bal: s.bal + r.bal, diff: s.diff + r.diff }),
    { open: 0, dr: 0, cr: 0, bal: 0, diff: 0 });
  const subHtml = (name, rs) => { const x = sum(rs); return `<tr class="sub"><td>${esc(name)} 計</td><td class="r num">${yen(x.open)}</td><td class="r num">${yen(x.dr)}</td><td class="r num">${yen(x.cr)}</td><td class="r num">${yen(x.bal)}</td><td class="r num">${x.diff > 0 ? "+" : ""}${yen(x.diff)}</td></tr>`; };
  if (t.byNo) {
    const rs = all.filter(visible).sort((x, y) => x.a.no - y.a.no);
    body = rs.map(rowHtml).join("");
  } else {
    CATEGORIES.forEach((cat) => {
      const rs = all.filter((r) => r.a.category === cat && visible(r)).sort((x, y) => x.a.no - y.a.no);
      if (!rs.length) return;
      body += `<tr class="grp"><td colspan="6">${esc(cat)}</td></tr>` + rs.map(rowHtml).join("") + subHtml(cat, rs);
    });
  }
  if (!body) body = `<tr><td colspan="6" class="empty">この期間の仕訳はありません。</td></tr>`;

  // 右側のカード
  const bsKind = (k) => all.filter((r) => r.a.kind === k);
  const cash = sum(all.filter((r) => r.a.category === "現金・預金"));
  const debt = sum(bsKind("liability"));
  const loan = all.find((r) => r.a.name === "長期借入金");
  const rev = sum(bsKind("revenue")).bal, exp = sum(bsKind("expense")).bal;
  const net = rev - exp;
  const sgn = (n) => (n >= 0 ? "+" : "-") + "¥" + yen(Math.abs(n));

  const modes = [["month", "月"], ["quarter", "四半期"], ["year", "年（1月〜）"], ["custom", "任意"]];
  const ym = (idx) => `${2000 + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
  $("view").innerHTML = `
    <div class="monthbar">
      <button type="button" class="navbtn" id="tb-prev" aria-label="前へ" ${t.mode === "custom" ? "disabled" : ""}>◀</button>
      <h2 id="tb-title" style="min-width:260px">${esc(periodTitle(S, E))}</h2>
      <button type="button" class="navbtn" id="tb-next" aria-label="次へ" ${t.mode === "custom" ? "disabled" : ""}>▶</button>
      <span class="note">試算表</span>
      <span class="spacer"></span>
      <div class="seg" id="tb-seg">${modes.map(([k, n]) => `<button type="button" data-mode="${k}" class="${t.mode === k ? "on" : ""}">${n}</button>`).join("")}</div>
      ${t.mode === "custom" ? `<input type="month" id="tb-from" value="${ym(S)}"> 〜 <input type="month" id="tb-to" value="${ym(E)}">` : ""}
      <span class="${okAll ? "okbadge" : "warnbadge"}">${okAll ? "貸借一致 ✓" : `貸借が合いません（差額 ¥${yen(Math.abs(allDr - allCr) || Math.abs(periodDr - periodCr))}）`}</span>
      <button type="button" class="sub" id="tb-csv">CSV</button>
      <button type="button" class="sub" id="tb-print">印刷</button>
    </div>
    <div class="tbgrid">
      <section class="panel nopad">
        <div class="panel-head"><h3><span class="bar"></span>科目ごとの残高</h3>
          <label class="note"><input type="checkbox" id="tb-hide" ${t.hideZero ? "checked" : ""}> 動きも残高もない科目を隠す</label>
          <label class="note"><input type="checkbox" id="tb-byno" ${t.byNo ? "checked" : ""}> 番号順（区分を分けない）</label></div>
        <div class="tablewrap"><table class="tbl tb">
          <thead><tr><th>科目</th><th class="r">月初残高</th><th class="r">借方</th><th class="r">貸方</th><th class="r">残高</th><th class="r">増減</th></tr></thead>
          <tbody>${body}
            <tr class="tot"><td>借方合計 ＝ 貸方合計</td><td></td><td class="r num">${yen(periodDr)}</td><td class="r num">${yen(periodCr)}</td>
              <td colspan="2" style="text-align:right">${periodDr === periodCr ? "一致 ✓" : "不一致"}</td></tr>
          </tbody></table></div>
      </section>
      <aside class="tbside">
        <div class="card"><div class="t">現金・預金類</div><div class="v">¥${yen(cash.bal)}</div>
          <div class="note">月初 ¥${yen(cash.open)} から ${diffHtml(cash.diff)}</div></div>
        <div class="card"><div class="t">負債合計</div><div class="v" style="color:#55309A">¥${yen(debt.bal)}</div>
          ${loan ? `<div class="note">うち長期借入金 ¥${yen(loan.bal)}</div>` : ""}</div>
        <div class="card"><div class="t">この期間の収益 − 経費（家計・税金を含む）</div>
          <div class="v ${net >= 0 ? "inc" : "out"}">${sgn(net)}</div>
          <div class="note">収益 ¥${yen(rev)} − 経費 ¥${yen(exp)}</div></div>
        <div class="card note">月初残高は、期間より前の仕訳をすべて足し引きして計算します。損益の科目は、期間の初めから数え直します。</div>
      </aside>
    </div>`;

  const redraw = () => draw(list);
  document.querySelector(".tbl.tb tbody").addEventListener("click", (e) => {
    const a = e.target.closest("a.lk");
    if (!a) return;
    e.preventDefault();
    state.lg = state.lg || { cond: null, mode: "none" };
    state.lg.preset = { accountId: a.dataset.acc, side: a.dataset.side, fromM: keyOf(S), toM: keyOf(E) };
    state.tab = "ledger";
    document.querySelector('#nav [data-tab="ledger"]').click();
  });
  $("tb-prev").addEventListener("click", () => { t.month = shiftMonth(t.month, t.mode === "quarter" ? -3 : t.mode === "year" ? -12 : -1); redraw(); });
  $("tb-next").addEventListener("click", () => { t.month = shiftMonth(t.month, t.mode === "quarter" ? 3 : t.mode === "year" ? 12 : 1); redraw(); });
  $("tb-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    if (b.dataset.mode === "custom" && !t.from) { t.from = shiftMonth(t.month, -2); t.to = t.month; }
    t.mode = b.dataset.mode;
    redraw();
  });
  if (t.mode === "custom") {
    const fromYm = (v) => keyOf((parseInt(v.slice(0, 4), 10) - 2000) * 12 + parseInt(v.slice(5, 7), 10) - 1);
    $("tb-from").addEventListener("change", (e) => { if (e.target.value) { t.from = fromYm(e.target.value); redraw(); } });
    $("tb-to").addEventListener("change", (e) => { if (e.target.value) { t.to = fromYm(e.target.value); redraw(); } });
  }
  $("tb-hide").addEventListener("change", (e) => { t.hideZero = e.target.checked; redraw(); });
  $("tb-byno").addEventListener("change", (e) => { t.byNo = e.target.checked; redraw(); });
  $("tb-print").addEventListener("click", () => window.print());
  $("tb-csv").addEventListener("click", () => {
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const lines = [["区分", "番号", "科目", "月初残高", "借方", "貸方", "残高", "増減"].map(q).join(",")];
    all.filter(visible).sort((x, y) => CATEGORIES.indexOf(x.a.category) - CATEGORIES.indexOf(y.a.category) || x.a.no - y.a.no)
      .forEach((r) => lines.push([q(r.a.category), r.a.no, q(r.a.name), r.open, r.dr, r.cr, r.bal, r.diff].join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `試算表_${ym(S)}${S === E ? "" : "_" + ym(E)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  });
}
