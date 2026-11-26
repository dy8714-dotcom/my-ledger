// 貸借内訳（9章・I8a）：科目の残高と、内訳（取引先ごと・固定資産ごと）の合計を照合する
import { state, loadAllVouchers, loadAssets } from "./state.js?v=0.2I8a";
import { $, esc, yen, accChip, shiftMonth, showError } from "./util.js?v=0.2I8a";
import { bsAt } from "./statements.js?v=0.2I8a";

const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
const labelOf = (idx) => `${2000 + Math.floor(idx / 12)}年${(idx % 12) + 1}月`;
const ymOf = (idx) => `${2000 + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
const q = (x) => `"${String(x).replace(/"/g, '""')}"`;

// 取引先ごとに内訳を出す科目（番号）
export const PARTY_NOS = [20, 22, 41, 45];

const accByNo = (accountsById, no) => Object.values(accountsById).find((a) => a.no === no);

// X月末時点の照合結果を作る。戻り値 { groups, bs, allOk }
export function computeBreakdown(list, accountsById, assets, X, parties) {
  const bs = bsAt(list, accountsById, X);
  const groups = [];

  PARTY_NOS.forEach((no) => {
    const a = accByNo(accountsById, no);
    if (!a || a.hidden) return;
    const sign = a.kind === "asset" ? 1 : -1; // 借方が増える科目は +、貸方が増える科目は −
    const by = {};
    list.forEach((v) => {
      if (idxOf(v.month) > X) return;
      (v.lines || []).forEach((l) => {
        if (l.accId !== a.id) return;
        const k = v.partyId || "";
        by[k] = (by[k] || 0) + (l.side === "debit" ? 1 : -1) * sign * (l.amount || 0);
      });
    });
    const nameOf = (id) => ((parties || state.parties || []).find((p) => p.id === id) || {}).name || "（削除された取引先）";
    const rows = Object.keys(by).filter((k) => k && by[k] !== 0).map((k) => ({ label: nameOf(k), amt: by[k] })).sort((p, r) => Math.abs(r.amt) - Math.abs(p.amt));
    const noParty = by[""] || 0;
    const total = rows.reduce((s, r) => s + r.amt, 0);
    const bal = bs.bal[a.id] || 0;
    groups.push({ key: "p" + no, title: `${a.no} ${a.name}`, sub: a.kind === "asset" ? "取引先ごと" : "支払先ごと", accIds: [a.id], rows, noParty, total, bal, diff: bal - total, ok: bal === total, link: a.id });
  });

  // 固定資産：登録した資産ごとの残額（取得額 − 償却済み）
  const accIds = new Set();
  (assets || []).forEach((as) => as.assetAccId && accIds.add(as.assetAccId));
  [33, 35].forEach((no) => { const a = accByNo(accountsById, no); if (a) accIds.add(a.id); });
  const fx = [];
  (assets || []).forEach((as) => {
    if (!as.acquiredDate || idxOf(as.acquiredDate.slice(2, 4) + "." + parseInt(as.acquiredDate.slice(5, 7), 10)) > X) return;
    let dep = 0;
    list.forEach((v) => {
      if (v.assetId !== as.id || idxOf(v.month) > X) return;
      (v.lines || []).forEach((l) => { if (l.side === "credit" && l.accId === as.assetAccId) dep += l.amount || 0; });
    });
    const rest = (as.amount || 0) - dep;
    if (rest !== 0) fx.push({ label: as.name, amt: rest, note: `取得 ${yen(as.amount || 0)}／償却済み ${yen(dep)}` });
  });
  const fxTotal = fx.reduce((s, r) => s + r.amt, 0);
  const fxBal = [...accIds].reduce((s, id) => s + (bs.bal[id] || 0), 0);
  if (fx.length || fxBal !== 0) {
    const nos = [...accIds].map((id) => (accountsById[id] || {}).no).filter(Boolean).sort((p, r) => p - r);
    groups.push({ key: "fx", title: `${nos.join("・")} 固定資産`, sub: "月割り償却と連動", accIds: [...accIds], rows: fx, noParty: 0, total: fxTotal, bal: fxBal, diff: fxBal - fxTotal, ok: fxBal === fxTotal, fixed: true });
  }
  const allOk = groups.every((g) => g.ok) && bs.gap === 0;
  return { groups, bs, allOk, ngCount: groups.filter((g) => !g.ok).length };
}

// 画面右上の「貸借一致 ✓　内訳照合 ✓」。読み込み済みのデータがあるときだけ計算する（読み込みの追加はしない）
export function refreshHeaderCheck() {
  const el = $("hdr-check");
  if (!el) return;
  if (!state.user || !state.allVouchers) { el.innerHTML = state.user ? `<span class="hc-off">貸借・内訳：未確認</span>` : ""; el.title = "B/S・貸借内訳などを開くと更新されます"; return; }
  try {
    const X = idxOf(state.month);
    const r = computeBreakdown(state.allVouchers, state.accountsById, state.assets, X, state.parties);
    const a = r.bs.gap === 0;
    el.innerHTML = `<span class="${a ? "hc-ok" : "hc-ng"}">貸借一致 ${a ? "✓" : "✗"}</span> <span class="${r.groups.every((g) => g.ok) ? "hc-ok" : "hc-ng"}">内訳照合 ${r.groups.every((g) => g.ok) ? "✓" : "⚠" + r.ngCount}</span>`;
    el.title = `${labelOf(X)}末の状態（記帳画面の月度）。クリックで貸借内訳を開きます`;
  } catch (err) { console.error("[貸借内訳] 照合の計算に失敗", err); el.innerHTML = ""; }
}

function stOf() {
  if (!state.st) state.st = { month: null, cmp: "prev", cmpMonth: null, scope: "all" };
  if (!state.st.month) state.st.month = state.month;
  return state.st;
}

export async function renderBreakdown() {
  $("view").innerHTML = `<div class="placeholder">計算しています…</div>`;
  let list;
  try { list = await loadAllVouchers(); if (!state.assets || !state.assets.length) await loadAssets(); }
  catch (err) { showError("仕訳の読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (state.tab !== "breakdown") return;
  draw(list);
}

const num = (n) => (n === 0 ? `<span class="muted">0</span>` : yen(n));
const openKeys = new Set();

function draw(list) {
  const st = stOf();
  const X = idxOf(st.month);
  const r = computeBreakdown(list, state.accountsById, state.assets, X, state.parties);

  const sum = r.groups.map((g) => `<tr><td>${g.link ? `<a href="#" class="lk" data-acc="${esc(g.link)}" data-from="20.1" data-to="${esc(st.month)}">${esc(g.title)}</a>` : esc(g.title)}</td><td class="r num">${num(g.bal)}</td><td class="r num">${num(g.total)}</td><td class="r ${g.ok ? "bk-ok" : "bk-ng"}">${g.ok ? "✓" : "⚠ 差 " + yen(Math.abs(g.diff))}</td></tr>`).join("");
  const later = `<tr class="muted"><td colspan="4" class="note">商品券・ポイント・その他銀行・金融資産の内訳は、次の版（I8b）で追加します。</td></tr>`;

  const body = r.groups.map((g) => {
    const open = openKeys.has(g.key) || !g.ok;
    const rows = g.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="r num">${num(x.amt)}</td><td class="muted">${esc(x.note || "")}</td></tr>`).join("") +
      (g.noParty ? `<tr class="bk-warnrow"><td>（取引先なし）</td><td class="r num">${num(g.noParty)}</td><td>取引先を付けると照合に入ります</td></tr>` : "") +
      (g.fixed && g.diff ? `<tr class="bk-warnrow"><td>（資産の登録なし）</td><td class="r num">${num(g.diff)}</td><td>設定の「月割り償却」に登録されていない分です</td></tr>` : "") +
      (!g.rows.length && !g.noParty && !(g.fixed && g.diff) ? `<tr><td colspan="3" class="muted">内訳はありません</td></tr>` : "") +
      `<tr class="tot"><td>内訳の合計</td><td class="r num">${num(g.total)}</td><td></td></tr>`;
    return `<section class="bkgrp${open ? "" : " bkclosed"}" data-key="${g.key}">
      <button type="button" class="bkhead"><span><span class="bkarrow">▸</span> ${esc(g.title)} <span class="note">（${esc(g.sub)}）</span></span><span class="${g.ok ? "bk-ok" : "bk-ng"}">${g.ok ? "✓" : "⚠"}　${yen(g.bal)}</span></button>
      <div class="bkbody"><table class="tbl tb st"><colgroup><col style="width:34%"><col style="width:22%"><col style="width:44%"></colgroup><thead><tr><th>${g.fixed ? "品名" : "取引先"}</th><th class="r">金額</th><th>備考</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join("");

  const gapBadge = `<span class="${r.bs.gap === 0 ? "okbadge" : "warnbadge"}">貸借一致 ${r.bs.gap === 0 ? "✓" : "✗ 差額 " + yen(r.bs.gap)}</span> <span class="${r.groups.every((g) => g.ok) ? "okbadge" : "warnbadge"}">内訳照合 ${r.groups.every((g) => g.ok) ? "✓" : "⚠ " + r.ngCount + "件"}</span>`;

  $("view").innerHTML = `<div class="monthbar">
      <button type="button" class="navbtn" id="bk-prev" aria-label="前の月">◀</button>
      <h2 style="min-width:190px">${esc(labelOf(X))}末</h2>
      <button type="button" class="navbtn" id="bk-next" aria-label="次の月">▶</button>
      <span class="note">貸借内訳</span><span class="spacer"></span>${gapBadge}
      <button type="button" class="sub" id="bk-csv">CSV</button><button type="button" class="sub" id="bk-print">印刷</button>
    </div>
    <section class="panel nopad"><div class="tablewrap"><table class="tbl tb st"><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup>
      <thead><tr><th>科目</th><th class="r">科目の残高</th><th class="r">内訳の合計</th><th class="r">照合</th></tr></thead><tbody>${sum}${later}</tbody></table></div></section>
    <div style="margin-top:10px">${body}</div>
    <div class="note" style="margin-top:8px">⚠ の科目は、開いた状態で表示します。見出しをクリックすると開閉できます。金額は、選んだ月の末日時点です。</div>`;

  $("bk-prev").addEventListener("click", () => { st.month = shiftMonth(st.month, -1); draw(list); });
  $("bk-next").addEventListener("click", () => { st.month = shiftMonth(st.month, 1); draw(list); });
  $("bk-print").addEventListener("click", () => window.print());
  $("bk-csv").addEventListener("click", () => {
    const L = [["科目", "内訳", "金額"].map(q).join(",")];
    r.groups.forEach((g) => {
      g.rows.forEach((x) => L.push([q(g.title), q(x.label), x.amt].join(",")));
      if (g.noParty) L.push([q(g.title), q("（取引先なし）"), g.noParty].join(","));
      L.push([q(g.title), q("科目の残高"), g.bal].join(","), [q(g.title), q("内訳の合計"), g.total].join(","));
    });
    const blob = new Blob(["﻿" + L.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `貸借内訳_${ymOf(X)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("view").onclick = (e) => {
    const h = e.target.closest(".bkhead");
    if (h) { const s = h.parentElement; s.classList.toggle("bkclosed"); (s.classList.contains("bkclosed") ? openKeys.delete(s.dataset.key) : openKeys.add(s.dataset.key)); return; }
    const a = e.target.closest("a.lk");
    if (!a) return;
    e.preventDefault();
    state.lg = state.lg || { cond: null, mode: "none" };
    state.lg.preset = { accountId: a.dataset.acc, side: "both", fromM: a.dataset.from, toM: a.dataset.to };
    state.tab = "ledger";
    document.querySelector('#nav [data-tab="ledger"]').click();
  };
  refreshHeaderCheck();
}
