// 貸借内訳（9章・I8a）：科目の残高と、内訳（取引先ごと・固定資産ごと）の合計を照合する
import { state, col, loadAllVouchers, loadAssets } from "./state.js?v=0.2I11a";
import { $, esc, yen, shiftMonth, showError, openModal, closeModal } from "./util.js?v=0.2I11a";
import { setDoc, doc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { bsAt } from "./statements.js?v=0.2I11a";

const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
const labelOf = (idx) => `${2000 + Math.floor(idx / 12)}年${(idx % 12) + 1}月`;
const ymOf = (idx) => `${2000 + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
const q = (x) => `"${String(x).replace(/"/g, '""')}"`;

// 取引先ごとに内訳を出す科目（番号）
export const PARTY_NOS = [20, 22, 41, 45];
// 月末に内訳を手入力する科目（商品券・ポイント・その他銀行・金融資産）
export const SNAP_DEFS = [
  { key: "s21", nos: [21], title: (a) => `${a[0].no} ${a[0].name}`, sub: "券の種類ごと・月末に入力", unit: "枚", labelName: "券の名前" },
  { key: "s24", nos: [24], title: (a) => `${a[0].no} ${a[0].name}`, sub: "ポイントの種類ごと・月末に入力", labelName: "ポイントの種類" },
  { key: "s18", nos: [18], title: (a) => `${a[0].no} ${a[0].name}`, sub: "銀行ごと・月末に入力", labelName: "銀行" },
  { key: "sfin", nos: [26, 27, 28, 29, 30], title: (a) => `${a.map((x) => x.no).join("・")} 金融資産`, sub: "口座区分×資産の種類・任意", labelName: "口座・資産の種類", optional: true }
];
// 商品券など枚数のある内訳は「1枚の金額 × 枚数」。古い入力（金額欄に1枚の金額を入れていたもの）も、その形に直して読む
export function normSnap(o, d) {
  if (!d || !d.unit) return o;
  const qty = o.qty || 0;
  const price = o.price !== undefined ? o.price || 0 : (qty > 0 ? o.amount || 0 : 0);
  return { ...o, price, qty, amount: qty > 0 || o.price !== undefined ? price * qty : o.amount || 0 };
}
const keyOfIdx = (i) => String(Math.floor(i / 12)).padStart(2, "0") + "." + ((i % 12) + 1);

const accByNo = (accountsById, no) => Object.values(accountsById).find((a) => a.no === no);

// X月末時点の照合結果を作る。戻り値 { groups, bs, allOk }
export function computeBreakdown(list, accountsById, assets, X, parties, openings = state.openings || [], baseMonth = state.baseMonth || null, snaps = state.snapshots || []) {
  const bs = bsAt(list, accountsById, X);
  const groups = [];
  const baseIdx = baseMonth ? idxOf(baseMonth) : null;
  // 基準月より前の月は、取引先ごとの内訳を出さない（基準月末の内訳から数え始めるため）
  if (baseIdx !== null && X < baseIdx) return { groups, bs, allOk: bs.gap === 0, ngCount: 0, before: true, baseIdx };
  const bsBase = baseIdx !== null ? bsAt(list, accountsById, baseIdx) : null;

  PARTY_NOS.forEach((no) => {
    const a = accByNo(accountsById, no);
    if (!a || a.hidden) return;
    const sign = a.kind === "asset" ? 1 : -1; // 借方が増える科目は +、貸方が増える科目は −
    const by = {};
    list.forEach((v) => {
      const mi = idxOf(v.month);
      if (mi > X || (baseIdx !== null && mi <= baseIdx)) return; // 基準月以前の履歴は数えない
      (v.lines || []).forEach((l) => {
        if (l.accId !== a.id) return;
        const k = v.partyId || "";
        by[k] = (by[k] || 0) + (l.side === "debit" ? 1 : -1) * sign * (l.amount || 0);
      });
    });
    const ops = openings.filter((o) => o.key === "p" + no && o.partyId);
    const opTotal = ops.reduce((s, o) => s + (o.amount || 0), 0);
    ops.forEach((o) => { by[o.partyId] = (by[o.partyId] || 0) + (o.amount || 0); });
    const nameOf = (id) => ((parties || state.parties || []).find((p) => p.id === id) || {}).name || "（削除された取引先）";
    const rows = Object.keys(by).filter((k) => k && by[k] !== 0).map((k) => ({ label: nameOf(k), amt: by[k] })).sort((p, r) => Math.abs(r.amt) - Math.abs(p.amt));
    const total = rows.reduce((s, r) => s + r.amt, 0);
    const bal = bs.bal[a.id] || 0;
    const noParty = bal - total; // 取引先に振り分けられていない分
    const baseBal = bsBase ? (bsBase.bal[a.id] || 0) : null;
    groups.push({ key: "p" + no, opTotal, baseBal, title: `${a.no} ${a.name}`, sub: a.kind === "asset" ? "取引先ごと" : "支払先ごと", accIds: [a.id], rows, noParty, total, bal, diff: bal - total, ok: bal === total, link: a.id });
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
  const fxOps = openings.filter((o) => o.key === "fx");
  fxOps.forEach((o) => { if (o.amount) fx.push({ label: o.label || "（期首の資産）", amt: o.amount || 0, note: "期首の内訳" }); });
  const fxTotal = fx.reduce((s, r) => s + r.amt, 0);
  const fxBal = [...accIds].reduce((s, id) => s + (bs.bal[id] || 0), 0);
  if (fx.length || fxBal !== 0) {
    const nos = [...accIds].map((id) => (accountsById[id] || {}).no).filter(Boolean).sort((p, r) => p - r);
    groups.push({ key: "fx", opTotal: fxOps.reduce((s, o) => s + (o.amount || 0), 0), title: `${nos.join("・")} 固定資産`, sub: "月割り償却と連動", accIds: [...accIds], rows: fx, noParty: 0, total: fxTotal, bal: fxBal, diff: fxBal - fxTotal, ok: fxBal === fxTotal, fixed: true });
  }
  // 月末の内訳（手入力）：商品券・ポイント・その他銀行・金融資産
  const mkey = keyOfIdx(X);
  SNAP_DEFS.forEach((d) => {
    const accs = d.nos.map((no) => accByNo(accountsById, no)).filter((a) => a && !a.hidden);
    if (!accs.length) return;
    const bal = accs.reduce((s, a) => s + (bs.bal[a.id] || 0), 0);
    const its = snaps.filter((o) => o.key === d.key && o.month === mkey).map((o) => normSnap(o, d));
    const rows = its.filter((o) => o.amount).map((o) => ({ label: o.label || "（品名なし）", amt: o.amount || 0, qty: o.qty || 0, price: o.price || 0, note: d.unit ? "" : o.qty ? `${o.qty}` : "" }));
    const qtyTotal = rows.reduce((s, r) => s + (r.qty || 0), 0);
    const total = rows.reduce((s, r) => s + r.amt, 0);
    const empty = its.length === 0;
    const skip = empty && (d.optional || bal === 0); // 内訳なしでも使える（任意）／残高0なら不要
    if (skip && bal === 0 && !d.always) return;
    groups.push({ key: d.key, snap: true, title: d.title(accs), sub: d.sub, accIds: accs.map((a) => a.id), rows, qtyTotal, noParty: 0, total, bal, diff: bal - total, ok: skip ? true : bal === total, skip, empty, opTotal: 0, unit: d.unit, labelName: d.labelName, optional: d.optional, mkey });
  });
  const allOk = groups.every((g) => g.ok) && bs.gap === 0;
  return { groups, bs, allOk, ngCount: groups.filter((g) => !g.ok).length, before: false, baseIdx };
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
    if (r.before) { el.innerHTML = `<span class="${a ? "hc-ok" : "hc-ng"}">貸借一致 ${a ? "✓" : "✗"}</span> <span class="hc-off">内訳：基準月前</span>`; return; }
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

  const sum = r.groups.map((g) => `<tr><td>${g.link ? `<a href="#" class="lk" data-acc="${esc(g.link)}" data-from="20.1" data-to="${esc(st.month)}">${esc(g.title)}</a>` : esc(g.title)}</td><td class="r num">${num(g.bal)}</td><td class="r num">${g.skip && g.bal ? "—" : num(g.total)}</td><td class="r ${g.ok ? "bk-ok" : "bk-ng"}">${g.skip && g.bal ? "内訳なし（任意）" : g.ok ? "✓" : g.snap && g.empty ? "⚠ 未入力" : "⚠ 差 " + yen(Math.abs(g.diff))}</td></tr>`).join("");
  const baseTxt = state.baseMonth ? `${labelOf(idxOf(state.baseMonth))}末` : "";
  const beforeNote = r.before ? `<tr><td colspan="4" class="note">基準月（${esc(baseTxt)}）より前の月は、取引先ごとの内訳を出しません。基準月以降の月を選んでください。</td></tr>` : "";
  const later = "";

  const body = r.groups.map((g) => {
    const open = openKeys.has(g.key) || !g.ok;
    const cols = g.unit ? 4 : 3;
    const rows = g.rows.map((x) => g.unit ? `<tr><td>${esc(x.label)}</td><td class="r num">${num(x.price)}</td><td class="r num">${x.qty}${esc(g.unit)}</td><td class="r num">${num(x.amt)}</td></tr>` : `<tr><td>${esc(x.label)}</td><td class="r num">${num(x.amt)}</td><td class="muted">${esc(x.note || "")}</td></tr>`).join("") +
      (g.noParty ? `<tr class="bk-warnrow"><td>（取引先なし）</td><td class="r num">${num(g.noParty)}</td><td>取引先を付けると照合に入ります</td></tr>` : "") +
      (g.snap && !g.empty && g.diff ? (g.unit ? `<tr class="bk-warnrow"><td>（内訳が足りない分）</td><td></td><td></td><td class="r num">${num(g.diff)}</td></tr>` : `<tr class="bk-warnrow"><td>（内訳が足りない分）</td><td class="r num">${num(g.diff)}</td><td>科目の残高との差です</td></tr>`) : "") +
      (g.fixed && g.diff ? `<tr class="bk-warnrow"><td>（資産の登録なし）</td><td class="r num">${num(g.diff)}</td><td>設定の「月割り償却」に登録されていない分です</td></tr>` : "") +
      (!g.rows.length && !g.noParty && !(g.fixed && g.diff) && !(g.snap && g.diff) ? `<tr><td colspan="${cols}" class="muted">内訳はありません</td></tr>` : "") +
      (g.snap && g.empty && g.diff ? (g.unit ? `<tr class="bk-warnrow"><td>（未入力）</td><td></td><td></td><td class="r num">${num(g.diff)}</td></tr>` : `<tr class="bk-warnrow"><td>（未入力）</td><td class="r num">${num(g.diff)}</td><td>この月の内訳をまだ入れていません</td></tr>`) : "") +
      (g.unit ? `<tr class="tot"><td>内訳の合計</td><td></td><td class="r num">${g.qtyTotal || 0}${esc(g.unit)}</td><td class="r num">${num(g.total)}</td></tr>` : `<tr class="tot"><td>内訳の合計</td><td class="r num">${num(g.total)}</td><td></td></tr>`);
    return `<section class="bkgrp${open ? "" : " bkclosed"}" data-key="${g.key}">
      <button type="button" class="bkhead"><span><span class="bkarrow">▸</span> ${esc(g.title)} <span class="note">（${esc(g.sub)}）</span></span><span class="${g.ok ? "bk-ok" : "bk-ng"}">${g.ok ? "✓" : "⚠"}　${yen(g.bal)}</span></button>
      <div class="bkbody"><div class="bkact">${g.snap ? `<button type="button" class="sub bksn" data-key="${g.key}">この月の内訳を入力${g.empty ? "" : "（入力済み）"}</button>` : `<button type="button" class="sub bkop" data-key="${g.key}">基準月末の内訳を登録${g.opTotal ? "（登録済み " + yen(g.opTotal) + "）" : ""}</button>`}</div><table class="tbl tb st">${g.unit ? `<colgroup><col style="width:40%"><col style="width:20%"><col style="width:16%"><col style="width:24%"></colgroup><thead><tr><th>${esc(g.labelName)}</th><th class="r">1${esc(g.unit)}の金額</th><th class="r">${esc(g.unit)}数</th><th class="r">金額（小計）</th></tr></thead>` : `<colgroup><col style="width:34%"><col style="width:22%"><col style="width:44%"></colgroup><thead><tr><th>${g.fixed ? "品名" : g.snap ? esc(g.labelName) : "取引先"}</th><th class="r">金額</th><th>備考</th></tr></thead>`}<tbody>${rows}</tbody></table></div></section>`;
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
      <thead><tr><th>科目</th><th class="r">科目の残高</th><th class="r">内訳の合計</th><th class="r">照合</th></tr></thead><tbody>${sum}${beforeNote}${later}</tbody></table></div></section>
    ${state.baseMonth ? `<div class="note" style="margin:8px 0">基準月：<strong>${esc(baseTxt)}</strong>。これより前の取引先ごとの履歴は数えず、基準月末の内訳（各科目の「基準月末の内訳を登録」）から数え始めます。 <input type="month" id="bk-basem" value="${ymOf(idxOf(state.baseMonth))}"> <button type="button" class="sub" id="bk-basego">基準月を変更</button></div>` : ""}
    <div style="margin-top:10px">${body}</div>
    <div class="note" style="margin-top:8px">⚠ の科目は、開いた状態で表示します。見出しをクリックすると開閉できます。金額は、選んだ月の末日時点です。</div>`;

  $("bk-prev").addEventListener("click", () => { st.month = shiftMonth(st.month, -1); draw(list); });
  $("bk-next").addEventListener("click", () => { st.month = shiftMonth(st.month, 1); draw(list); });
  const bg = $("bk-basego");
  if (bg) bg.addEventListener("click", async () => {
    const v = $("bk-basem").value;
    if (!v) return;
    const m = String(parseInt(v.slice(0, 4), 10) - 2000) + "." + parseInt(v.slice(5, 7), 10);
    if (m === state.baseMonth) return;
    if (!window.confirm(`基準月を ${v.slice(0, 4)}年${parseInt(v.slice(5, 7), 10)}月末 に変更します。\n入力済みの「基準月末の内訳」は、新しい基準月末の金額として扱われます。必要なら入れ直してください。`)) return;
    try {
      await setDoc(doc(col("meta"), "openings"), { items: state.openings || [], baseMonth: m, updatedAt: Date.now() });
      state.baseMonth = m; draw(list);
    } catch (err) { showError("基準月の保存に失敗しました：" + (err.code || err.message)); }
  });
  $("bk-print").addEventListener("click", () => window.print());
  $("bk-csv").addEventListener("click", () => {
    const L = [["科目", "内訳", "金額"].map(q).join(",")];
    r.groups.forEach((g) => {
      g.rows.forEach((x) => L.push([q(g.title), q(x.label + (g.unit ? `（${x.price}円×${x.qty}${g.unit}）` : "")), x.amt].join(",")));
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
    const sb = e.target.closest(".bksn");
    if (sb) { openSnapshot(r.groups.find((x) => x.key === sb.dataset.key), () => draw(list)); return; }
    const ob = e.target.closest(".bkop");
    if (ob) { openOpening(r.groups.find((x) => x.key === ob.dataset.key), () => draw(list)); return; }
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

// ---------- 期首の内訳（取引先を付けられない期首仕訳の分を、ここで振り分ける） ----------
function openOpening(g, redraw) {
  if (!g) return;
  const mine = (state.openings || []).filter((o) => o.key === g.key);
  const parties = [...(state.parties || [])].sort((p, r) => String(p.kana || p.name).localeCompare(String(r.kana || r.name), "ja"));
  const opt = (sel) => `<option value="">（選ぶ）</option>` + parties.map((p) => `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  const rowHtml = (o) => `<tr>
      <td>${g.fixed ? `<input type="text" class="op-label" value="${esc(o.label || "")}" placeholder="品名など">` : `<select class="op-party">${opt(o.partyId)}</select>`}</td>
      <td><input type="text" inputmode="numeric" class="op-amt" value="${o.amount ? esc(String(o.amount)) : ""}" placeholder="金額"></td>
      <td><button type="button" class="sub op-del" aria-label="この行を消す">×</button></td></tr>`;
  const base = g.fixed ? g.diff + g.opTotal : (g.baseBal !== null && g.baseBal !== undefined ? g.baseBal : g.noParty + g.opTotal); // 振り分ける対象（取引先別は基準月末の科目残高）
  openModal(`<div class="dialog" role="dialog" aria-modal="true" style="max-width:560px">
    <h2>基準月末の内訳　${esc(g.title)}</h2>
    <p class="note">${g.fixed ? "資産として登録していない分を、品名ごとに分けて入れます。" : "基準月末に実際に残っている分を、取引先ごとに入れます（基準月以前の取引先別の履歴は数えません）。"}仕訳そのものは変わりません。</p>
    <p class="note">振り分ける対象：<strong>${yen(base)}</strong>　／　入力した合計：<strong id="op-sum">0</strong>　／　残り：<strong id="op-rest">0</strong></p>
    <table class="tbl mtbl"><colgroup><col style="width:62%"><col style="width:30%"><col style="width:8%"></colgroup><thead><tr><th>${g.fixed ? "品名" : "取引先"}</th><th>金額（円）</th><th></th></tr></thead><tbody id="op-rows">${(mine.length ? mine : [{}]).map(rowHtml).join("")}</tbody></table>
    <p><button type="button" class="sub" id="op-add">＋ 行を追加</button></p>
    <p class="note" id="op-msg"></p>
    <div class="actions"><button type="button" class="sub" id="op-cancel">閉じる</button><button type="button" class="primary" id="op-save">保存</button></div></div>`);
  const body = $("op-rows");
  const num = (t) => parseInt(String(t || "").replace(/[,，\s]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10) || 0;
  const read = () => [...body.querySelectorAll("tr")].map((tr) => ({ key: g.key, partyId: (tr.querySelector(".op-party") || {}).value || "", label: ((tr.querySelector(".op-label") || {}).value || "").trim(), amount: num(tr.querySelector(".op-amt").value) }));
  const sum = () => { const t = read().reduce((s, o) => s + o.amount, 0); $("op-sum").textContent = yen(t); $("op-rest").textContent = yen(base - t); };
  sum();
  $("modal").oninput = sum; $("modal").onchange = sum;
  $("modal").onclick = (e) => {
    if (e.target.closest(".op-del")) { e.target.closest("tr").remove(); if (!body.children.length) body.insertAdjacentHTML("beforeend", rowHtml({})); sum(); }
  };
  $("op-add").onclick = () => body.insertAdjacentHTML("beforeend", rowHtml({}));
  $("op-cancel").onclick = () => { $("modal").onclick = null; $("modal").oninput = null; $("modal").onchange = null; closeModal(); };
  $("op-save").onclick = async () => {
    const items = read().filter((o) => o.amount);
    if (items.some((o) => (g.fixed ? !o.label : !o.partyId))) return ($("op-msg").textContent = g.fixed ? "品名を入れてください。" : "取引先を選んでください。");
    $("op-save").disabled = true; $("op-msg").textContent = "保存中…";
    try {
      const all = [...(state.openings || []).filter((o) => o.key !== g.key), ...items];
      await setDoc(doc(col("meta"), "openings"), { items: all, baseMonth: state.baseMonth || null, updatedAt: Date.now() });
      state.openings = all;
      $("modal").onclick = null; $("modal").oninput = null; $("modal").onchange = null;
      closeModal(); redraw();
    } catch (err) { $("op-save").disabled = false; $("op-msg").textContent = "保存に失敗しました：" + (err.code || err.message); }
  };
}

// ---------- 月末の内訳（商品券・ポイント・その他銀行・金融資産）：その月の内訳を手で入れる ----------
function openSnapshot(g, redraw) {
  if (!g) return;
  const mkey = g.mkey;
  const d = SNAP_DEFS.find((x) => x.key === g.key) || {};
  const all = state.snapshots || [];
  const mine = all.filter((o) => o.key === g.key && o.month === mkey).map((o) => normSnap(o, d));
  const prevMonths = [...new Set(all.filter((o) => o.key === g.key && idxOf(o.month) < idxOf(mkey)).map((o) => o.month))].sort((a, b) => idxOf(b) - idxOf(a));
  const prev = prevMonths.length ? all.filter((o) => o.key === g.key && o.month === prevMonths[0]).map((o) => normSnap(o, d)) : [];
  const U = g.unit;
  const inp = "width:100%;box-sizing:border-box";
  const rowHtml = (o) => `<tr>
      <td><input type="text" class="sn-label" style="${inp}" value="${esc(o.label || "")}" placeholder="${esc(g.labelName)}"></td>
      ${U ? `<td><input type="text" inputmode="numeric" class="sn-price" style="${inp};text-align:right" value="${o.price ? esc(String(o.price)) : ""}" placeholder="1${esc(U)}の金額"></td>
      <td><input type="text" inputmode="numeric" class="sn-qty" style="${inp};text-align:right" value="${o.qty ? esc(String(o.qty)) : ""}" placeholder="${esc(U)}数"></td>
      <td class="r num sn-sub">0</td>` : `<td><input type="text" inputmode="numeric" class="sn-amt" style="${inp};text-align:right" value="${o.amount ? esc(String(o.amount)) : ""}" placeholder="金額"></td>`}
      <td><button type="button" class="sub sn-del" aria-label="この行を消す">×</button></td></tr>`;
  const cg = U ? `<colgroup><col style="width:36%"><col style="width:19%"><col style="width:13%"><col style="width:24%"><col style="width:8%"></colgroup>` : `<colgroup><col style="width:58%"><col style="width:34%"><col style="width:8%"></colgroup>`;
  openModal(`<div class="dialog" role="dialog" aria-modal="true" style="max-width:820px;width:96vw">
    <h2>月末の内訳　${esc(g.title)}　${esc(mkey)}月度末</h2>
    <p class="note">${esc(g.mkey)}月度末の内訳を、${esc(g.labelName)}ごとに入れます。${U ? `「1${esc(U)}の金額 × ${esc(U)}数」が小計になります。` : ""}仕訳は変わりません。</p>
    <p class="note">科目の残高：<strong>${yen(g.bal)}</strong>　／　入力した合計：<strong id="sn-sum">0</strong>　／　残り：<strong id="sn-rest">0</strong>${U ? `　／　${esc(U)}数の合計：<strong id="sn-qsum">0</strong>` : ""}</p>
    <table class="tbl mtbl">${cg}<thead><tr><th>${esc(g.labelName)}</th>${U ? `<th class="r">1${esc(U)}の金額</th><th class="r">${esc(U)}数</th><th class="r">小計</th>` : `<th class="r">金額（円）</th>`}<th></th></tr></thead><tbody id="sn-rows">${(mine.length ? mine : [{}]).map(rowHtml).join("")}</tbody></table>
    <p><button type="button" class="sub" id="sn-add">＋ 行を追加</button>${prev.length ? ` <button type="button" class="sub" id="sn-copy">${esc(prevMonths[0])}月度末の内容をコピー</button>` : ""}</p>
    <p class="note" id="sn-msg"></p>
    <div class="actions"><button type="button" class="sub" id="sn-cancel">閉じる</button><button type="button" class="primary" id="sn-save">保存</button></div></div>`);
  const body = $("sn-rows");
  const num = (t) => parseInt(String(t || "").replace(/[,，\s]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10) || 0;
  const read = () => [...body.querySelectorAll("tr")].map((tr) => {
    const o = { key: g.key, month: mkey, label: tr.querySelector(".sn-label").value.trim() };
    if (U) { o.price = num(tr.querySelector(".sn-price").value); o.qty = num(tr.querySelector(".sn-qty").value); o.amount = o.price * o.qty; }
    else { o.qty = 0; o.amount = num(tr.querySelector(".sn-amt").value); }
    return o;
  });
  const sum = () => {
    const L = read();
    if (U) body.querySelectorAll("tr").forEach((tr, i) => { tr.querySelector(".sn-sub").textContent = yen(L[i].amount); });
    const t = L.reduce((s, o) => s + o.amount, 0);
    $("sn-sum").textContent = yen(t); $("sn-rest").textContent = yen(g.bal - t);
    if (U) $("sn-qsum").textContent = String(L.reduce((s, o) => s + o.qty, 0));
  };
  sum();
  const off = () => { $("modal").onclick = null; $("modal").oninput = null; $("modal").onchange = null; };
  $("modal").oninput = sum; $("modal").onchange = sum;
  $("modal").onclick = (e) => { if (e.target.closest(".sn-del")) { e.target.closest("tr").remove(); if (!body.children.length) body.insertAdjacentHTML("beforeend", rowHtml({})); sum(); } };
  $("sn-add").onclick = () => body.insertAdjacentHTML("beforeend", rowHtml({}));
  if ($("sn-copy")) $("sn-copy").onclick = () => { body.innerHTML = prev.map(rowHtml).join(""); sum(); };
  $("sn-cancel").onclick = () => { off(); closeModal(); };
  $("sn-save").onclick = async () => {
    const items = read().filter((o) => o.amount || o.label || o.qty);
    if (items.some((o) => !o.label)) return ($("sn-msg").textContent = `${g.labelName}を入れてください。`);
    $("sn-save").disabled = true; $("sn-msg").textContent = "保存中…";
    try {
      const next = [...all.filter((o) => !(o.key === g.key && o.month === mkey)), ...items];
      await setDoc(doc(col("meta"), "snapshots"), { items: next, updatedAt: Date.now() });
      state.snapshots = next; off(); closeModal(); redraw();
    } catch (err) { $("sn-save").disabled = false; $("sn-msg").textContent = "保存に失敗しました：" + (err.code || err.message); }
  };
}
