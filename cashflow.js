// C/F（キャッシュフロー）：CF計算書（営業・投資・財務）と、日別の資金の動き（I9a）
import { state, loadAllVouchers } from "./state.js?v=0.2I11a";
import { $, esc, yen, shiftMonth, showError } from "./util.js?v=0.2I11a";
import { bsAt, compareMonth } from "./statements.js?v=0.2I11a";

const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
const keyOf = (i) => String(Math.floor(i / 12)).padStart(2, "0") + "." + ((i % 12) + 1);
const labelOf = (i) => `${2000 + Math.floor(i / 12)}年${(i % 12) + 1}月`;
const ymOf = (i) => `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
const WD = ["日", "月", "火", "水", "木", "金", "土"];

// 現金として扱う科目：0〜19番の資産（設計書の初期値）
export const isCash = (a) => !!a && a.kind === "asset" && a.no >= 0 && a.no <= 19;

// CF計算書の行（順番どおりに表示）
export const CF_ROWS = [
  { key: "op_sales", group: "op", label: "売上（その場で入金）", party: true },
  { key: "op_ar", group: "op", label: "売掛金の回収", party: true },
  { key: "op_sal", group: "op", label: "給与（総支給額）" },
  { key: "op_misc", group: "op", label: "雑収入・その他の収入" },
  { key: "op_biz", group: "op", label: "事業の経費" },
  { key: "op_life", group: "op", label: "生活費" },
  { key: "op_tax", group: "op", label: "税金・社会保険" },
  { key: "op_adv", group: "op", label: "立替・仮払金の精算（仮払・仮受・前受・前払）" },
  { key: "op_pay", group: "op", label: "未払費用・買掛金などの支払い" },
  { key: "op_other", group: "op", label: "その他（商品券・ポイント・特別損益など）" },
  { key: "inv_fin", group: "inv", label: "証券口座・仮想通貨への入出金" },
  { key: "inv_fix", group: "inv", label: "固定資産の購入・売却" },
  { key: "inv_sale", group: "inv", label: "固定資産の売却益・売却損" },
  { key: "fin_debt", group: "fin", label: "借入・返済" }
];
const GROUPS = [["op", "営業CF（日々のお金の出入り）", "営業CF 計"], ["inv", "投資CF（証券・仮想通貨・固定資産）", "投資CF 計"], ["fin", "財務CF（借入・返済）", "財務CF 計"]];

// 現金以外の明細が、どの行に入るか
export function classify(a, l) {
  const c = a.category;
  if (a.kind === "asset") {
    if (c === "金融資産") return "inv_fin";
    if (c === "固定資産") return "inv_fix";
    if (a.no === 20) return "op_ar";
    if ([22, 23, 25].includes(a.no)) return "op_adv";
    return "op_other";
  }
  if (a.kind === "liability") {
    if ([44, 45, 46, 47].includes(a.no)) return "fin_debt";
    if ([38, 39].includes(a.no)) return "op_adv";
    return "op_pay";
  }
  if (a.kind === "revenue") {
    if (c === "評価・特別損益") return [86, 87].includes(a.no) ? "inv_sale" : "op_other";
    if (a.no === 48) return "op_sales";
    if (a.no === 90) return "op_sal";
    return "op_misc";
  }
  if (a.kind === "expense") {
    if (c === "税金・社会保険") return "op_tax";
    if (c === "評価・特別損益") return [86, 87].includes(a.no) ? "inv_sale" : "op_other";
    return l.biz === "biz" ? "op_biz" : "op_life";
  }
  return "op_other"; // 純資産（事業主貸・借）など
}

// 1枚の仕訳の現金への影響。cash＝現金・預金の増減、parts＝現金以外の明細ごとの影響（貸方−借方）。期首残高の仕訳（元入金あり）は opening 扱い
export function voucherCash(v, accountsById) {
  let cash = 0, hasCash = false, opening = false;
  const parts = [];
  (v.lines || []).forEach((l) => {
    const a = accountsById[l.accId];
    if (!a) return;
    if (isCash(a)) { hasCash = true; cash += (l.side === "debit" ? 1 : -1) * (l.amount || 0); return; }
    if (a.no === 98) opening = true;
    parts.push({ a, l, eff: (l.side === "credit" ? 1 : -1) * (l.amount || 0) });
  });
  return { cash, hasCash, opening, parts };
}

// S〜E月（通し番号）の集計。戻り値 { rows:{key:{total, accs:{id:{amt, parties}}}}, g:{op,inv,fin}, net, opening }
export function computeCF(list, accountsById, S, E) {
  const rows = {};
  CF_ROWS.forEach((r) => { rows[r.key] = { total: 0, accs: {} }; });
  let opening = 0;
  list.forEach((v) => {
    const mi = idxOf(v.month);
    if (mi < S || mi > E) return;
    const vc = voucherCash(v, accountsById);
    if (!vc.hasCash) return;
    if (vc.opening) { opening += vc.cash; return; }
    vc.parts.forEach((p) => {
      const key = classify(p.a, p.l);
      const r = rows[key];
      r.total += p.eff;
      const ac = r.accs[p.a.id] || (r.accs[p.a.id] = { amt: 0, parties: {} });
      ac.amt += p.eff;
      const pid = v.partyId || "";
      ac.parties[pid] = (ac.parties[pid] || 0) + p.eff;
    });
  });
  const g = { op: 0, inv: 0, fin: 0 };
  CF_ROWS.forEach((r) => { g[r.group] += rows[r.key].total; });
  return { rows, g, net: g.op + g.inv + g.fin, opening };
}

// 現金・預金の残高（X月末）。B/S（試算表）から出す
export function cashBalance(list, accountsById, X) {
  const bs = bsAt(list, accountsById, X);
  return Object.values(accountsById).filter(isCash).reduce((s, a) => s + (bs.bal[a.id] || 0), 0);
}

// 日別：月内の全日について 流入・流出・差引・累計
export function computeDaily(list, accountsById, X) {
  const start = cashBalance(list, accountsById, X - 1);
  const days = new Date(2000 + Math.floor(X / 12), (X % 12) + 1, 0).getDate();
  const ymd = (d) => `${ymOf(X)}-${String(d).padStart(2, "0")}`;
  const by = {};
  for (let d = 1; d <= days; d++) by[ymd(d)] = { date: ymd(d), inflow: 0, outflow: 0, opening: 0 };
  list.forEach((v) => {
    if (idxOf(v.month) !== X) return;
    const vc = voucherCash(v, accountsById);
    if (!vc.hasCash || !by[v.date]) return;
    if (vc.opening) { by[v.date].opening += vc.cash; return; }
    if (vc.cash > 0) by[v.date].inflow += vc.cash; else by[v.date].outflow += vc.cash;
  });
  let cum = start;
  const out = Object.values(by).map((r) => { cum += r.inflow + r.outflow + r.opening; return { ...r, net: r.inflow + r.outflow, cum }; });
  return { start, rows: out, end: cum };
}

function stOf() {
  if (!state.st) state.st = { month: null, cmp: "prev", cmpMonth: null, scope: "all" };
  if (!state.st.month) state.st.month = state.month;
  return state.st;
}
const num = (n) => (n === 0 ? `<span class="muted">0</span>` : yen(n));
const dif = (n) => (n === 0 ? `<span class="muted">0</span>` : (n > 0 ? "+" : "-") + yen(Math.abs(n)));
const openRows = new Set();

export async function renderCF() {
  $("view").innerHTML = `<div class="placeholder">計算しています…</div>`;
  let list;
  try { list = await loadAllVouchers(); }
  catch (err) { showError("仕訳の読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (state.tab !== "cf") return;
  draw(list);
}

function bar(st, X, Yk, sub) {
  const cmpOpts = [["prev", "前月"], ["lastyear", "昨年の同じ月"], ["custom", "好きな月"]];
  return `<div class="monthbar">
    <button type="button" class="navbtn" id="cf-prev" aria-label="前の月">◀</button>
    <h2 style="min-width:190px">${esc(labelOf(X))}</h2>
    <button type="button" class="navbtn" id="cf-next" aria-label="次の月">▶</button>
    <span class="note">キャッシュフロー（C/F）</span><span class="spacer"></span>
    <div class="seg" id="cf-sub"><button type="button" data-sub="stmt" class="${sub === "stmt" ? "on" : ""}">CF計算書</button><button type="button" data-sub="daily" class="${sub === "daily" ? "on" : ""}">日別の資金の動き</button></div>
    ${sub === "stmt" ? `<span class="note">比べる月：</span><div class="seg" id="cf-cmp">${cmpOpts.map(([k, n]) => `<button type="button" data-cmp="${k}" class="${st.cmp === k ? "on" : ""}">${n}</button>`).join("")}</div>
    ${st.cmp === "custom" ? `<input type="month" id="cf-cmpm" value="${ymOf(idxOf(Yk))}">` : `<span class="note">（${esc(labelOf(idxOf(Yk)))}）</span>`}` : ""}
    <button type="button" class="sub" id="cf-csv">CSV</button><button type="button" class="sub" id="cf-print">印刷</button>
  </div>`;
}

function draw(list) {
  const st = stOf();
  if (!state.cfSub) state.cfSub = "stmt";
  const X = idxOf(st.month), Yk = compareMonth(st.month, st), Y = idxOf(Yk), y0 = X - (X % 12);
  const acc = state.accountsById;
  let csv;
  if (state.cfSub === "daily") csv = drawDaily(list, st, X, Yk);
  else csv = drawStmt(list, st, X, Y, Yk, y0, acc);

  $("cf-prev").addEventListener("click", () => { st.month = shiftMonth(st.month, -1); draw(list); });
  $("cf-next").addEventListener("click", () => { st.month = shiftMonth(st.month, 1); draw(list); });
  $("cf-sub").addEventListener("click", (e) => { const b = e.target.closest("button[data-sub]"); if (b) { state.cfSub = b.dataset.sub; draw(list); } });
  const cm = $("cf-cmp");
  if (cm) cm.addEventListener("click", (e) => { const b = e.target.closest("button[data-cmp]"); if (!b) return; st.cmp = b.dataset.cmp; if (st.cmp === "custom" && !st.cmpMonth) st.cmpMonth = shiftMonth(st.month, -1); draw(list); });
  const cmm = $("cf-cmpm");
  if (cmm) cmm.addEventListener("change", (e) => { if (e.target.value) { st.cmpMonth = String(parseInt(e.target.value.slice(0, 4), 10) - 2000) + "." + parseInt(e.target.value.slice(5, 7), 10); draw(list); } });
  $("cf-print").addEventListener("click", () => window.print());
  $("cf-csv").addEventListener("click", () => {
    const blob = new Blob(["﻿" + csv().join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `C-F_${state.cfSub === "daily" ? "日別_" : ""}${ymOf(X)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("view").onclick = (e) => {
    const t = e.target.closest(".cf-tog");
    if (t) { const k = t.dataset.key; (openRows.has(k) ? openRows.delete(k) : openRows.add(k)); draw(list); return; }
    const a = e.target.closest("a.lk");
    if (!a) return;
    e.preventDefault();
    state.lg = state.lg || { cond: null, mode: "none" };
    state.lg.preset = { accountId: a.dataset.acc, side: "both", fromM: a.dataset.from, toM: a.dataset.to };
    state.tab = "ledger";
    document.querySelector('#nav [data-tab="ledger"]').click();
  };
}

function drawStmt(list, st, X, Y, Yk, y0, acc) {
  const cols = [computeCF(list, acc, X, X), computeCF(list, acc, Y, Y), computeCF(list, acc, y0, X)];
  const starts = [cashBalance(list, acc, X - 1), cashBalance(list, acc, Y - 1), cashBalance(list, acc, y0 - 1)];
  const ends = [cashBalance(list, acc, X), cashBalance(list, acc, Y), cashBalance(list, acc, X)];
  const partyName = (id) => id ? ((state.parties || []).find((p) => p.id === id) || {}).name || "（削除された取引先）" : "（取引先なし）";
  const lk = (a, fromM, toM, html) => `<a href="#" class="lk" data-acc="${esc(a.id)}" data-from="${fromM}" data-to="${toM}">${html}</a>`;
  const mk = (label, vals, cls, withDiff = true) => `<tr class="${cls}"><td>${label}</td><td class="r num">${num(vals[0])}</td><td class="r num muted2">${num(vals[1])}</td><td class="r num">${withDiff ? dif(vals[0] - vals[1]) : ""}</td><td class="r num">${num(vals[2])}</td></tr>`;

  let body = "";
  GROUPS.forEach(([g, title, totalLabel]) => {
    body += `<tr class="grp"><td colspan="5">${esc(title)}</td></tr>`;
    CF_ROWS.filter((r) => r.group === g).forEach((r) => {
      const v = cols.map((c) => c.rows[r.key].total);
      const accIds = new Set(); cols.forEach((c) => Object.keys(c.rows[r.key].accs).forEach((k) => accIds.add(k)));
      if (!v[0] && !v[1] && !v[2] && !accIds.size) return;
      const open = openRows.has(r.key);
      body += mk(`<button type="button" class="cf-tog linkbtn" data-key="${r.key}">${open ? "▾" : "▸"} ${esc(r.label)}</button>`, v, "");
      if (open) {
        [...accIds].map((id) => acc[id]).filter(Boolean).sort((a, b) => a.no - b.no).forEach((a) => {
          const av = cols.map((c) => (c.rows[r.key].accs[a.id] || { amt: 0 }).amt);
          body += `<tr class="sub2"><td style="padding-left:28px">${lk(a, "20.1", keyOf(X), esc(a.no + " " + a.name))}</td><td class="r num">${num(av[0])}</td><td class="r num muted2">${num(av[1])}</td><td class="r num">${dif(av[0] - av[1])}</td><td class="r num">${num(av[2])}</td></tr>`;
          if (r.party) {
            const pids = new Set(); cols.forEach((c) => Object.keys((c.rows[r.key].accs[a.id] || { parties: {} }).parties).forEach((k) => pids.add(k)));
            [...pids].sort((p, s) => Math.abs(((cols[0].rows[r.key].accs[a.id] || { parties: {} }).parties[s] || 0)) - Math.abs(((cols[0].rows[r.key].accs[a.id] || { parties: {} }).parties[p] || 0))).forEach((pid) => {
              const pv = cols.map((c) => ((c.rows[r.key].accs[a.id] || { parties: {} }).parties[pid] || 0));
              if (!pv[0] && !pv[1] && !pv[2]) return;
              body += `<tr class="sub2 muted"><td style="padding-left:52px">${esc(partyName(pid))}</td><td class="r num">${num(pv[0])}</td><td class="r num">${num(pv[1])}</td><td class="r num">${dif(pv[0] - pv[1])}</td><td class="r num">${num(pv[2])}</td></tr>`;
            });
          }
        });
      }
    });
    body += mk(totalLabel, cols.map((c) => c.g[g]), "sub");
  });
  body += mk("現金・預金の増減（営業＋投資＋財務）", cols.map((c) => c.net), "tot");
  if (cols.some((c) => c.opening)) body += mk("期首残高の計上（元入金）", cols.map((c) => c.opening), "");
  body += mk("はじめの現金・預金（累計の列は年初）", starts, "", false);
  body += mk("終わりの現金・預金（月末）", ends, "tot", false);

  const okC = starts[0] + cols[0].net + cols[0].opening === ends[0];
  const okP = starts[1] + cols[1].net + cols[1].opening === ends[1];
  const okY = starts[2] + cols[2].net + cols[2].opening === ends[2];
  const ok = okC && okP && okY;
  const fcf = cols.map((c) => c.g.op + c.g.inv);
  const check = `<div class="${ok ? "okbadge" : "warnbadge"}" id="cf-check">現金の増減が、B/Sの現金・預金の増減と ${ok ? "一致 ✓" : "合いません ✗（当月 " + (okC ? "✓" : "✗") + " ／ 比較月 " + (okP ? "✓" : "✗") + " ／ 今年 " + (okY ? "✓" : "✗") + "）"}　　フリーキャッシュフロー（営業＋投資）：${yen(fcf[0])}</div>`;

  $("view").innerHTML = bar(st, X, Yk, "stmt") + `<div class="note" style="margin:-4px 0 10px">${check}</div>
    <section class="panel nopad"><div class="tablewrap"><table class="tbl tb st cft"><colgroup><col style="width:40%"><col style="width:15%"><col style="width:15%"><col style="width:15%"><col style="width:15%"></colgroup>
      <thead><tr><th>項目</th><th class="r">${esc(labelOf(X))}</th><th class="r">${esc(labelOf(Y))}</th><th class="r">増減</th><th class="r">${2000 + Math.floor(X / 12)}年の累計（1月〜${(X % 12) + 1}月）</th></tr></thead>
      <tbody>${body}</tbody></table></div></section>
    <div class="note" style="margin-top:8px">現金・預金は0〜19番の科目です。現金が動かない仕訳（評価替え・月割り償却など）は入りません。行の ▸ を押すと、科目ごと（売上・売掛金は取引先ごと）の内訳が開きます。</div>`;

  return () => {
    const L = [["区分", "項目", "科目・取引先", labelOf(X), labelOf(Y), "増減", "今年の累計"].map(q).join(",")];
    GROUPS.forEach(([g, title, totalLabel]) => {
      CF_ROWS.filter((r) => r.group === g).forEach((r) => {
        const v = cols.map((c) => c.rows[r.key].total);
        if (v[0] || v[1] || v[2]) L.push([q(title), q(r.label), "", v[0], v[1], v[0] - v[1], v[2]].join(","));
        const accIds = new Set(); cols.forEach((c) => Object.keys(c.rows[r.key].accs).forEach((k) => accIds.add(k)));
        [...accIds].map((id) => acc[id]).filter(Boolean).sort((a, b) => a.no - b.no).forEach((a) => {
          const av = cols.map((c) => (c.rows[r.key].accs[a.id] || { amt: 0 }).amt);
          L.push([q(title), q(r.label), q(a.no + " " + a.name), av[0], av[1], av[0] - av[1], av[2]].join(","));
        });
      });
      const t = cols.map((c) => c.g[g]);
      L.push([q(title), q(totalLabel), "", t[0], t[1], t[0] - t[1], t[2]].join(","));
    });
    L.push([q("合計"), q("現金・預金の増減"), "", cols[0].net, cols[1].net, cols[0].net - cols[1].net, cols[2].net].join(","));
    L.push([q("合計"), q("月末の現金・預金"), "", ends[0], ends[1], ends[0] - ends[1], ends[2]].join(","));
    return L;
  };
}

function drawDaily(list, st, X, Yk) {
  const d = computeDaily(list, state.accountsById, X);
  const endBS = cashBalance(list, state.accountsById, X);
  const ok = d.end === endBS;
  const rows = d.rows.map((r) => {
    const dt = new Date(r.date + "T00:00:00");
    const wd = dt.getDay();
    const cls = wd === 0 ? "sun" : wd === 6 ? "sat" : "";
    return `<tr class="${cls}"><td>${parseInt(r.date.slice(5, 7), 10)}/${parseInt(r.date.slice(8, 10), 10)}（${WD[wd]}）</td><td class="r num">${num(r.inflow)}</td><td class="r num">${num(r.outflow)}</td><td class="r num">${r.opening ? `${dif(r.net)}<span class="note">　期首 ${yen(r.opening)}</span>` : dif(r.net)}</td><td class="r num">${yen(r.cum)}</td></tr>`;
  }).join("");
  const tin = d.rows.reduce((s, r) => s + r.inflow, 0), tout = d.rows.reduce((s, r) => s + r.outflow, 0);
  $("view").innerHTML = bar(st, X, Yk, "daily") + `<div class="note" style="margin:-4px 0 10px"><span class="${ok ? "okbadge" : "warnbadge"}" id="cf-check">月末の累計が、B/Sの現金・預金と ${ok ? "一致 ✓" : "合いません ✗"}</span></div>
    <section class="panel nopad"><div class="tablewrap"><table class="tbl tb st cft"><colgroup><col style="width:24%"><col style="width:19%"><col style="width:19%"><col style="width:19%"><col style="width:19%"></colgroup>
      <thead><tr><th>日付</th><th class="r">流入</th><th class="r">流出</th><th class="r">差引</th><th class="r">累計残高</th></tr></thead>
      <tbody><tr class="sub"><td>月初の現金・預金</td><td></td><td></td><td></td><td class="r num">${yen(d.start)}</td></tr>${rows}
      <tr class="tot"><td>合計</td><td class="r num">${num(tin)}</td><td class="r num">${num(tout)}</td><td class="r num">${dif(tin + tout)}</td><td class="r num">${yen(d.end)}</td></tr></tbody></table></div></section>
    <div class="note" style="margin-top:8px">1枚の仕訳ごとの、現金・預金（0〜19番）の増減です。現金・預金どうしの移動（資金移動）は、増減が0なので入りません。</div>`;
  return () => {
    const L = [["日付", "流入", "流出", "差引", "累計残高"].map(q).join(","), [q("月初"), "", "", "", d.start].join(",")];
    d.rows.forEach((r) => L.push([q(r.date), r.inflow, r.outflow, r.net, r.cum].join(",")));
    return L;
  };
}
