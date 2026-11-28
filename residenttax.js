// 住民税（自分で納付）（手順I11f）：年度ごとに4期の納付額と納期限を管理し、納めたら記帳する
import { state, col, db, fetchMonthVouchers, loadVouchers, loadAllVouchers, isClosed } from "./state.js?v=0.2I11f";
import { $, esc, yen, ymd, monthOf, showError } from "./util.js?v=0.2I11f";
import { offReason, shiftBusiness } from "./holidays.js?v=0.2I11f";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const pad = (n) => String(n).padStart(2, "0");
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const accByNo = (no) => state.accounts.find((a) => a.no === no);

// 年度 Y（Y年6月〜Y+1年5月）の4期。原則の納期限は 6/30・8/31・10/31・翌1/31。土日祝にあたるときは次の平日にする
export function periodsOf(Y) {
  const base = [[Y, 6], [Y, 8], [Y, 10], [Y + 1, 1]].map(([y, m]) => `${y}-${pad(m)}-${pad(lastDom(y, m))}`);
  return base.map((b, i) => {
    const why = offReason(b);
    const due = why ? shiftBusiness(b, "next") : b;
    return { n: i + 1, base: b, due, why, note: why ? `（${parseInt(b.slice(5, 7), 10)}/${parseInt(b.slice(8, 10), 10)}が${why}にあたるので、次の平日）` : "" };
  });
}
// 年税額を4期に分ける（2〜4期は100円単位、端数は第1期）
export function splitTotal(total) {
  const t = Math.round(total || 0), o = Math.floor(t / 4 / 100) * 100;
  return [t - o * 3, o, o, o];
}
export const fiscalYearOf = (date) => { const y = parseInt(date.slice(0, 4), 10), m = parseInt(date.slice(5, 7), 10); return m >= 6 ? y : y - 1; };
export const daysTo = (from, to) => Math.round((Date.UTC(...to.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) - Date.UTC(...from.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)))) / 86400000);

// 納付の仕訳（1期ごと、またはまとめて）。picks: [{n, amount}]
export function buildTaxVoucher(Y, picks, date, bankId) {
  const tax = accByNo(94), total = picks.reduce((x, p) => x + p.amount, 0);
  const fld = state.fields.find((f) => f.no === 66);
  return {
    id: `jtax_${Y}_p${picks.map((p) => p.n).join("")}`,
    v: {
      month: monthOf(date), date, fieldId: fld ? fld.id : "", partyId: "", mark: "", batchId: `jtax-${Y}`,
      lines: [
        ...picks.map((p) => ({ side: "debit", accId: tax.id, amount: p.amount, tax: 0, memo: `住民税 ${Y}年度 第${p.n}期`, tags: [], biz: "life" })),
        { side: "credit", accId: bankId, amount: total, tax: 0, memo: picks.length > 1 ? `住民税 ${Y}年度 第${picks.map((p) => p.n).join("・")}期` : `住民税 ${Y}年度 第${picks[0].n}期`, tags: [], biz: "life" }
      ]
    }
  };
}

let DOC = { years: {} }, Y = 0, MSG = "";
const bankOptions = (sel) => state.accounts.filter((a) => a.no >= 0 && a.no <= 19 && !a.hidden).map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${esc(a.no + " " + a.name)}</option>`).join("");
const yrec = () => (DOC.years[Y] = DOC.years[Y] || { total: 0, periods: [1, 2, 3, 4].map((n) => ({ n, amount: 0, paidDate: "", accId: "", voucherId: "" })) });
const save = () => setDoc(doc(col("meta"), "residentTax"), DOC);

export async function renderTax(host) {
  host.innerHTML = `<p class="note">読み込んでいます…</p>`;
  try {
    const snap = await getDoc(doc(col("meta"), "residentTax"));
    DOC = snap.exists() ? { years: {}, ...snap.data() } : { years: {} };
    if (!DOC.years) DOC.years = {};
  } catch (err) { host.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (!Y) Y = fiscalYearOf(ymd(new Date()));
  draw(host);
}

function draw(host) {
  const R = yrec(), ps = periodsOf(Y), today = ymd(new Date());
  const defBank = (accByNo(12) || {}).id || "";
  const paid = R.periods.filter((p) => p.voucherId).reduce((x, p) => x + (Number(p.amount) || 0), 0);
  const left = R.periods.filter((p) => !p.voucherId).reduce((x, p) => x + (Number(p.amount) || 0), 0);
  const rows = ps.map((d) => {
    const p = R.periods[d.n - 1], done = !!p.voucherId;
    const dt = daysTo(today, d.due);
    const st = done ? `<span class="chip biz">記帳済み</span>` : !(p.amount > 0) ? `<span class="muted">金額なし</span>` : dt < 0 ? `<span class="chip late">期限を${-dt}日過ぎています</span>` : `<span class="chip late" style="background:#fff4e0">あと${dt}日</span>`;
    return `<tr><td>${done || !(p.amount > 0) ? "" : `<input type="checkbox" data-pick="${d.n}">`}</td><td>第${d.n}期</td><td>${esc(d.due)}<div class="note">${esc(d.note)}</div></td>
      <td class="amt"><input type="text" inputmode="numeric" data-amt="${d.n}" value="${p.amount || ""}" ${done ? "disabled" : ""} style="width:100px;text-align:right"></td>
      <td><input type="date" data-date="${d.n}" value="${esc(done ? p.paidDate : p.paidDate || today)}" ${done ? "disabled" : ""} style="width:140px"></td>
      <td><select data-acc="${d.n}" ${done ? "disabled" : ""}>${bankOptions(p.accId || defBank)}</select></td><td>${st}</td>
      <td>${done ? `<button type="button" data-undo="${d.n}">取り消す</button>` : p.amount > 0 ? `<button type="button" data-pay="${d.n}">記帳する</button>` : ""}</td></tr>`;
  }).join("");
  host.innerHTML = `<div class="toolbar"><label>年度 <select id="rt-y">${[Y - 1, Y, Y + 1].map((y) => `<option value="${y}"${y === Y ? " selected" : ""}>${y}年度（${y}年6月〜${y + 1}年5月）</option>`).join("")}</select></label>
    <label>年税額 <input type="text" inputmode="numeric" id="rt-total" value="${R.total || ""}" style="width:110px;text-align:right"></label><button type="button" id="rt-split">4期に分ける</button>
    <span class="note">通知書の金額を、各期に直接入れてもかまいません</span></div>
  <div class="tablewrap"><table class="tbl" style="min-width:0"><thead><tr><th></th><th>期</th><th>納期限</th><th class="amt">納付額</th><th>納付日</th><th>払った口座</th><th>状態</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="toolbar" style="justify-content:space-between"><span>納付済み ¥${yen(paid)}　／　残り ¥${yen(left)}</span><button type="button" id="rt-bulk">チェックした期をまとめて記帳</button></div>
  <p class="note">納期限が土日祝にあたるときは、次の平日にしてあります（市の通知書と違うときは、納付日の欄は自由に入れられます）。まとめて払うときは、期にチェックを付けて「まとめて記帳」を押します（納付日と口座は、いちばん上にチェックした期のものです）。生活の支出として記帳します（事業の経費にはしません）。</p>
  <p class="note" id="rt-msg">${esc(MSG)}</p>`;
  $("rt-y").addEventListener("change", (e) => { Y = parseInt(e.target.value, 10); MSG = ""; draw(host); });
  const total = $("rt-total");
  total.addEventListener("change", async () => { R.total = parseN(total.value); await save(); });
  $("rt-split").addEventListener("click", async () => {
    if (R.periods.some((p) => p.voucherId)) { MSG = "記帳済みの期があるので、分け直せません。各期の金額を直接直してください。"; draw(host); return; }
    R.total = parseN(total.value); splitTotal(R.total).forEach((a, i) => { R.periods[i].amount = a; });
    await save(); MSG = ""; draw(host);
  });
  host.querySelectorAll("[data-amt]").forEach((i) => i.addEventListener("change", async () => { R.periods[+i.dataset.amt - 1].amount = parseN(i.value); await save(); draw(host); }));
  host.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => pay(host, [+b.dataset.pay], +b.dataset.pay)));
  $("rt-bulk").addEventListener("click", () => {
    const ns = [...host.querySelectorAll("[data-pick]")].filter((c) => c.checked).map((c) => +c.dataset.pick);
    if (!ns.length) { $("rt-msg").textContent = "まとめて払う期にチェックを付けてください。"; return; }
    pay(host, ns, ns[0]);
  });
  host.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", () => undo(host, +b.dataset.undo)));
}
const parseN = (s) => { const n = Number(String(s).replace(/[,，\s¥円]/g, "")); return Number.isFinite(n) ? Math.round(n) : 0; };

async function pay(host, ns, lead) {
  const R = yrec(), msg = $("rt-msg");
  const date = host.querySelector(`[data-date="${lead}"]`).value, accId = host.querySelector(`[data-acc="${lead}"]`).value;
  const picks = ns.map((n) => ({ n, amount: parseN(host.querySelector(`[data-amt="${n}"]`).value) })).filter((p) => p.amount > 0);
  if (!date) { msg.textContent = "納付日を入れてください。"; return; }
  if (!picks.length) { msg.textContent = "納付額を入れてください。"; return; }
  if (isClosed(monthOf(date))) { msg.textContent = `${monthOf(date)}は締めてあります。月末の画面で締めを外してから記帳してください。`; return; }
  try {
    const { id, v } = buildTaxVoucher(Y, picks, date, accId);
    const list = await fetchMonthVouchers(v.month);
    const today = ymd(new Date());
    await setDoc(doc(col("vouchers"), id), { ...v, seq: Math.max(list.maxSeqAll || 0, ...list.map((x) => x.seq || 0)) + 1, entryDate: today, late: today > date, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    picks.forEach((p) => { const r = R.periods[p.n - 1]; r.amount = p.amount; r.paidDate = date; r.accId = accId; r.voucherId = id; });
    await save();
    state.allVouchers = null; await loadVouchers();
    MSG = `記帳しました（${date}・${picks.map((p) => "第" + p.n + "期").join("・")}・¥${yen(picks.reduce((x, p) => x + p.amount, 0))}）。`;
    draw(host);
  } catch (err) { console.error("[住民税]", err); showError("記帳に失敗しました：" + (err.code || err.message)); }
}

async function undo(host, n) {
  const R = yrec(), p = R.periods[n - 1];
  const same = R.periods.filter((q) => q.voucherId === p.voucherId);
  if (!window.confirm(`${same.length > 1 ? "まとめて記帳した" + same.map((q) => "第" + q.n + "期").join("・") + "を" : "第" + n + "期の記帳を"}取り消します。よろしいですか？（仕訳は「削除した仕訳」に30日間残ります）`)) return;
  try {
    await updateDoc(doc(col("vouchers"), p.voucherId), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() });
    same.forEach((q) => { q.voucherId = ""; q.paidDate = ""; });
    await save(); state.allVouchers = null; await loadVouchers();
    MSG = "取り消しました。"; draw(host);
  } catch (err) { console.error("[住民税]", err); showError("取り消しに失敗しました：" + (err.code || err.message)); }
}
