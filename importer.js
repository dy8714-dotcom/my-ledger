// 過去データの取り込み（手順H）：仕訳CSV → 検査 → プレビュー → 登録
import { state, col, db, loadAllVouchers, loadParties, loadStats, loadVouchers } from "./state.js?v=0.1H";
import { $, esc, norm, yen, monthOf, showError } from "./util.js?v=0.1H";
import { doc, writeBatch, serverTimestamp, increment, arrayUnion }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

// ---------- CSVを読む ----------
export function decodeBytes(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""); }
  catch (e) { return new TextDecoder("shift_jis").decode(buf); } // Excelの「CSV」(Shift-JIS)にも対応
}

export function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const COLS = {
  date: ["日付"], no: ["伝番"], side: ["借貸"], accNo: ["科目番号"], accName: ["科目"], amount: ["金額"],
  tax: ["税率", "税区分"], memo: ["摘要"], field: ["分野"], party: ["取引先"], biz: ["事業"], mark: ["印"], entry: ["記帳日"]
};

const t = (s) => String(s ?? "").normalize("NFKC").trim();

function parseDate(s) {
  const m = t(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

// ---------- 検査して、登録の計画を作る ----------
// existing: すでにある仕訳（月度＋連番の重複を見る）
export function buildPlan(rows, ctx, existing) {
  const { accounts, fieldsById, parties } = ctx;
  const errors = [];
  const err = (where, msg) => errors.push({ where, msg });
  if (rows.length < 2) { err("ファイル", "データの行がありません。"); return { errors, vouchers: [], newParties: [], totals: { d: 0, c: 0 } }; }

  const head = rows[0].map(t);
  const idx = {};
  for (const k of Object.keys(COLS)) idx[k] = head.findIndex((h) => COLS[k].includes(h));
  for (const [k, label] of [["date", "日付"], ["no", "伝番"], ["side", "借貸"], ["amount", "金額"]]) {
    if (idx[k] < 0) err("見出し", `「${label}」の列が見つかりません。`);
  }
  if (idx.accNo < 0 && idx.accName < 0) err("見出し", "「科目番号」（または「科目」）の列が見つかりません。");
  if (errors.length) return { errors, vouchers: [], newParties: [], totals: { d: 0, c: 0 } };

  const get = (r, k) => (idx[k] >= 0 ? r[idx[k]] ?? "" : "");
  const accByNo = {}, accByName = {};
  accounts.forEach((a) => { accByNo[a.no] = a; accByName[norm(a.name)] = a; });
  const fieldByName = {};
  Object.values(fieldsById).forEach((f) => { fieldByName[norm(f.name)] = f; });
  const partyByName = {};
  parties.forEach((p) => { partyByName[norm(p.name)] = p; });
  const taken = new Set((existing || []).map((v) => v.month + "-" + v.seq));

  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], where = `${i + 1}行目`;
    const no = t(get(r, "no"));
    if (!no) { err(where, "伝番が空です。"); continue; }
    if (!groups.has(no)) groups.set(no, { no, rows: [] });
    groups.get(no).rows.push({ r, where });
  }

  const vouchers = [], newPartyNames = new Map();
  let totD = 0, totC = 0;
  for (const g of groups.values()) {
    const e0 = errors.length;
    const m = g.no.match(/^(\d{2}\.\d{1,2})-(\d+)$/);
    if (!m) { err(`伝番 ${g.no}`, "伝番は「26.11-3」の形（月度-連番）で入れてください。"); continue; }
    const month = m[1], seq = parseInt(m[2], 10);
    const f = g.rows[0];
    const date = parseDate(get(f.r, "date"));
    if (!date) { err(f.where, `日付「${get(f.r, "date")}」を読めません（2026-11-25 の形で）。`); continue; }
    if (monthOf(date) !== month) err(f.where, `伝番の月度（${month}）と日付（${date}）が合いません。`);
    if (taken.has(g.no)) err(`伝番 ${g.no}`, "同じ伝番の仕訳がすでに登録されています。");
    let entryDate = parseDate(get(f.r, "entry")) || date;
    const mark = t(get(f.r, "mark"));
    if (mark && !["☆", "★", "◇", "◆"].includes(mark)) err(f.where, `印「${mark}」は ☆ ★ ◇ ◆ のどれかにしてください。`);
    const fieldName = t(get(f.r, "field")), partyName = t(get(f.r, "party"));
    let fieldId = "";
    if (fieldName) {
      const fl = fieldByName[norm(fieldName)];
      if (fl) fieldId = fl.id; else err(f.where, `分野「${fieldName}」が設定にありません。先に設定の分野で作ってください。`);
    }
    const lines = []; let d = 0, c = 0;
    for (const { r, where } of g.rows) {
      if (parseDate(get(r, "date")) !== date) err(where, "同じ伝番の中で日付が違います。");
      const sd = t(get(r, "side"));
      const side = /^(借方?|debit)$/i.test(sd) ? "debit" : /^(貸方?|credit)$/i.test(sd) ? "credit" : null;
      if (!side) { err(where, `借貸「${sd}」は「借方」か「貸方」にしてください。`); continue; }
      let acc = null;
      const an = t(get(r, "accNo")), nm = t(get(r, "accName"));
      if (an) { acc = accByNo[parseInt(an, 10)]; if (!acc) err(where, `科目番号「${an}」が設定にありません。`); }
      else if (nm) { acc = accByName[norm(nm)]; if (!acc) err(where, `科目「${nm}」が設定にありません。`); }
      else err(where, "科目番号が空です。");
      const amt = t(get(r, "amount")).replace(/[,¥円]/g, "");
      if (!/^\d+$/.test(amt) || parseInt(amt, 10) <= 0) { err(where, `金額「${get(r, "amount")}」は1以上の整数にしてください。`); continue; }
      const tx = t(get(r, "tax")).replace(/%$/, "");
      const tax = tx === "" || tx === "ー" || tx === "-" ? 0 : parseInt(tx, 10);
      if (![0, 8, 10].includes(tax)) err(where, `税率「${get(r, "tax")}」は 空欄・8・10 のどれかにしてください。`);
      const bz = t(get(r, "biz"));
      const biz = bz === "事業" || bz === "biz" ? "biz" : bz === "生活" || bz === "life" ? "life" : "";
      if (!acc) continue;
      const amount = parseInt(amt, 10);
      if (side === "debit") d += amount; else c += amount;
      lines.push({ side, accId: acc.id, amount, tax, memo: t(get(r, "memo")), tags: [], biz, _acc: acc });
    }
    if (d !== c) err(`伝番 ${g.no}`, `借方${yen(d)}と貸方${yen(c)}が合いません（差 ${yen(Math.abs(d - c))}）。`);
    if (!lines.some((l) => l.side === "debit") || !lines.some((l) => l.side === "credit")) err(`伝番 ${g.no}`, "借方と貸方の両方が必要です。");
    // 事業/生活が空欄のときは、記帳画面と同じ決め方にする
    const plFirst = lines.map((l) => l._acc).find((a) => a.kind === "expense" || a.kind === "revenue");
    lines.forEach((l) => {
      if (!l.biz) l.biz = l._acc.kind === "expense" || l._acc.kind === "revenue" ? l._acc.biz || "life" : plFirst ? plFirst.biz || "life" : "life";
      delete l._acc;
    });
    let partyId = "", isNewParty = false;
    if (partyName) {
      const p = partyByName[norm(partyName)];
      if (p) partyId = p.id; else { isNewParty = true; newPartyNames.set(norm(partyName), partyName); }
    }
    if (errors.length === e0) { totD += d; totC += c; }
    vouchers.push({ no: g.no, month, seq, date, entryDate, late: entryDate > date, mark, fieldId, partyId, partyName, isNewParty, lines, amount: d });
  }
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  return { errors, vouchers, newParties: [...newPartyNames.values()], totals: { d: totD, c: totC } };
}

// ---------- 登録 ----------
const uid = (() => { let n = 0; return () => Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 4); })();

function statIds(ids) {
  const u = [...new Set(ids.filter(Boolean))];
  const pl = u.filter((id) => { const a = state.accountsById[id]; return a && (a.kind === "expense" || a.kind === "revenue"); });
  return pl.length ? pl : u;
}

export async function commitPlan(plan, onProgress) {
  const ops = [];   // [type, ref, data, opt]
  const partyIds = {};
  plan.newParties.forEach((name) => {
    const id = "pty_" + uid();
    partyIds[norm(name)] = id;
    ops.push(["set", doc(col("parties"), id), { name, kana: "", fieldIds: [], spot: false, hidden: false, count: 0, createdAt: serverTimestamp() }]);
  });
  const per = {}, accField = {}, fieldParty = {};
  plan.vouchers.forEach((v) => {
    const pid = v.partyId || (v.partyName ? partyIds[norm(v.partyName)] : "") || "";
    const lines = v.lines;
    ops.push(["set", doc(col("vouchers"), "v_" + uid()), {
      month: v.month, seq: v.seq, date: v.date, entryDate: v.entryDate, late: v.late,
      fieldId: v.fieldId, partyId: pid, mark: v.mark, lines,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), imported: true
    }]);
    if (pid) {
      const p = per[pid] || (per[pid] = { count: 0, last: "", fields: new Set() });
      p.count++; if (v.date > p.last) p.last = v.date; if (v.fieldId) p.fields.add(v.fieldId);
    }
    if (v.fieldId) {
      statIds(lines.map((l) => l.accId)).forEach((a) => { const k = a + "__" + v.fieldId; accField[k] = (accField[k] || 0) + 1; });
      if (pid) { const k = v.fieldId + "__" + pid; fieldParty[k] = (fieldParty[k] || 0) + 1; }
    }
  });
  const newIds = new Set(Object.values(partyIds));
  Object.keys(per).forEach((pid) => {
    const p = per[pid], cur = state.partiesById[pid];
    const upd = { count: increment(p.count), lastUsed: cur && cur.lastUsed > p.last ? cur.lastUsed : p.last };
    if (p.fields.size) upd.fieldIds = arrayUnion(...p.fields);
    ops.push([newIds.has(pid) ? "set" : "update", doc(col("parties"), pid), upd, newIds.has(pid) ? { merge: true } : undefined]);
  });
  const inc = (o) => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, increment(n)]));
  if (Object.keys(accField).length || Object.keys(fieldParty).length) {
    ops.push(["set", doc(col("meta"), "stats"), { accField: inc(accField), fieldParty: inc(fieldParty) }, { merge: true }]);
  }
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach(([type, ref, data, opt]) => (type === "set" ? (opt ? batch.set(ref, data, opt) : batch.set(ref, data)) : batch.update(ref, data)));
    await batch.commit();
    if (onProgress) onProgress(Math.min(i + 400, ops.length), ops.length);
  }
  state.allVouchers = null;
  await loadParties(); await loadStats(); await loadVouchers();
}

// ---------- 画面 ----------
export function renderImport() {
  $("settings-body").innerHTML = `
    <div class="card" style="max-width:900px">
      <h3>過去データの取り込み</h3>
      <p class="note">仕訳CSV（バックアップで出すCSVと同じ形）を読み込みます。まず検査とプレビューだけを行い、エラーが0件のときだけ「取り込む」が押せます。</p>
      <p><input type="file" id="im-file" accept=".csv,text/csv"></p>
      <div id="im-result"></div>
    </div>`;
  $("im-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const out = $("im-result");
    out.innerHTML = `<p class="note">検査中…</p>`;
    try {
      const rows = parseCsv(decodeBytes(await f.arrayBuffer()));
      const existing = await loadAllVouchers();
      const plan = buildPlan(rows, { accounts: state.accounts, fieldsById: state.fieldsById, parties: state.parties }, existing);
      drawPlan(plan, out);
    } catch (err) { out.innerHTML = ""; showError("読み込みに失敗しました：" + err.message); }
  });
}

function drawPlan(plan, out) {
  const bad = plan.errors.length > 0;
  const balanced = plan.totals.d === plan.totals.c;
  const shown = plan.errors.slice(0, 100);
  out.innerHTML = `
    <div class="${bad ? "warnbadge" : "okbadge"}">${bad ? `エラー ${plan.errors.length}件（直してから、もう一度ファイルを選んでください）` : "エラーなし"}</div>
    <p>仕訳 <strong>${plan.vouchers.length}</strong> 件　借方合計 <strong>${yen(plan.totals.d)}</strong>　貸方合計 <strong>${yen(plan.totals.c)}</strong>　${balanced ? "→ 1円のズレなし" : "→ <span style='color:#b3261e'>借方と貸方が合いません</span>"}</p>
    ${plan.newParties.length ? `<p>新しく作る取引先（${plan.newParties.length}件）：${esc(plan.newParties.slice(0, 30).join("、"))}${plan.newParties.length > 30 ? " ほか" : ""}</p>` : ""}
    ${bad ? `<table class="tbl"><thead><tr><th>場所</th><th>内容</th></tr></thead><tbody>${shown.map((x) => `<tr><td>${esc(x.where)}</td><td>${esc(x.msg)}</td></tr>`).join("")}</tbody></table>${plan.errors.length > shown.length ? `<p class="note">ほか ${plan.errors.length - shown.length}件</p>` : ""}` : `
    <table class="tbl"><thead><tr><th>伝番</th><th>日付</th><th>借方</th><th>貸方</th><th>取引先</th><th class="amt">金額</th></tr></thead><tbody>
    ${plan.vouchers.slice(0, 30).map((v) => `<tr><td>${esc(v.no)}</td><td>${esc(v.date)}</td>
      <td>${esc([...new Set(v.lines.filter((l) => l.side === "debit").map((l) => (state.accountsById[l.accId] || {}).name))].join("・"))}</td>
      <td>${esc([...new Set(v.lines.filter((l) => l.side === "credit").map((l) => (state.accountsById[l.accId] || {}).name))].join("・"))}</td>
      <td>${esc(v.partyName)}</td><td class="amt">${yen(v.amount)}</td></tr>`).join("")}</tbody></table>
    ${plan.vouchers.length > 30 ? `<p class="note">先頭30件だけ表示しています（全${plan.vouchers.length}件）。</p>` : ""}
    <p><button type="button" class="primary" id="im-go" ${plan.vouchers.length && balanced ? "" : "disabled"}>${plan.vouchers.length}件を取り込む</button> <span id="im-msg" class="note"></span></p>`}`;
  const go = $("im-go");
  if (go) go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      await commitPlan(plan, (a, b) => { $("im-msg").textContent = `登録中… ${a}/${b}`; });
      $("im-msg").textContent = `取り込みました（${plan.vouchers.length}件）。記帳・試算表で確認してください。`;
    } catch (err) { go.disabled = false; $("im-msg").textContent = ""; showError("取り込みに失敗しました：" + (err.code || err.message) + "（途中まで登録された可能性があります。バックアップと突き合わせてください）"); }
  });
}
