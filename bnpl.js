// 後払い（手順I11g）：Paidy・メルペイスマート払いなどの後払い会社と、引落の予定・記帳
import { state, col, db, fetchMonthVouchers, loadVouchers, loadAllVouchers, isClosed } from "./state.js?v=0.2I11g";
import { $, esc, yen, ymd, monthOf, openModal, closeModal, showError } from "./util.js?v=0.2I11g";
import { shiftBusiness, offReason } from "./holidays.js?v=0.2I11g";
import { doc, getDocs, setDoc, updateDoc, serverTimestamp, deleteField } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const accByNo = (no) => state.accounts.find((a) => a.no === no);
const pad = (n) => String(n).padStart(2, "0");
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const listBnpl = () => (state.bnpl || []).filter((b) => b.active !== false);

export async function reloadBnpl() {
  const snap = await getDocs(col("bnpl"));
  state.bnpl = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja"));
  return state.bnpl;
}

// 買った日が、どの締め月（"2026-10"）にあたるか。closeDay: 0 は月末
export function cycleOf(B, date) {
  const y = parseInt(date.slice(0, 4), 10), m = parseInt(date.slice(5, 7), 10), d = parseInt(date.slice(8, 10), 10);
  const cd = B.closeDay ? B.closeDay : lastDom(y, m);
  if (d <= cd) return `${y}-${pad(m)}`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${pad(nm)}`;
}
export function closeDateOf(B, cycle) {
  const y = parseInt(cycle.slice(0, 4), 10), m = parseInt(cycle.slice(5, 7), 10);
  return `${cycle}-${pad(B.closeDay ? Math.min(B.closeDay, lastDom(y, m)) : lastDom(y, m))}`;
}
// 引き落とし日：締め月から payOffset か月あとの payDay 日。休日なら休日の扱いに従う
export function dueOf(B, cycle) {
  const y = parseInt(cycle.slice(0, 4), 10), m = parseInt(cycle.slice(5, 7), 10);
  const t = y * 12 + (m - 1) + (B.payOffset === 0 ? 0 : B.payOffset || 1);
  const yy = Math.floor(t / 12), mm = (t % 12) + 1;
  const raw = `${yy}-${pad(mm)}-${pad(Math.min(B.payDay || 27, lastDom(yy, mm)))}`;
  const mode = B.holiday || "next";
  return { raw, due: mode === "none" || !offReason(raw) ? raw : shiftBusiness(raw, mode), why: offReason(raw) };
}
export const payId = (B, cycle) => `bnpl_${B.id}_${cycle.replace("-", "_")}`;

// 引落の予定の一覧。amount＝その会社を選んで買った分（41の貸方）−返品など（41の借方）。引き落とし自体の仕訳は数えない
export function schedule(list, bnplList, today) {
  const rows = [];
  const a41 = accByNo(41); if (!a41) return rows;
  bnplList.forEach((B) => {
    const by = {};
    list.forEach((v) => {
      if (v.deleted || v.payVia !== B.id || v.kind === "bnpl") return;
      (v.lines || []).forEach((l) => { if (l.accId === a41.id) { const c = cycleOf(B, v.date); by[c] = (by[c] || 0) + (l.side === "credit" ? 1 : -1) * (l.amount || 0); } });
    });
    const pays = {};
    list.forEach((v) => { if (!v.deleted && v.kind === "bnpl" && v.payVia === B.id && v.cycle) pays[v.cycle] = v; });
    new Set([...Object.keys(by), ...Object.keys(pays)]).forEach((cycle) => {
      const planned = by[cycle] || 0, pv = pays[cycle] || null;
      if (!planned && !pv) return;
      const d = dueOf(B, cycle);
      const actual = pv ? (pv.lines || []).filter((l) => l.side === "credit" && (accNoOf(l.accId) <= 19)).reduce((x, l) => x + l.amount, 0) : null;
      rows.push({ B, cycle, closeDate: closeDateOf(B, cycle), due: d.due, why: d.why, planned, paid: !!pv, voucher: pv, actual, diff: pv ? actual - planned : null, closed: closeDateOf(B, cycle) <= today });
    });
  });
  return rows.sort((a, b) => a.due.localeCompare(b.due));
}
const accNoOf = (id) => { const a = state.accountsById[id]; return a ? a.no : 99; };
const mdw = (d) => { const w = "日月火水木金土"[new Date(d + "T00:00:00").getDay()]; return `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}（${w}）`; };

// ---------- 画面（設定の「後払い」） ----------
export async function renderBnpl() {
  const host = $("settings-body");
  host.innerHTML = `<section class="panel"><p class="note">読み込んでいます…</p></section>`;
  let list;
  try { await reloadBnpl(); list = await loadAllVouchers(); } catch (err) { host.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  draw(host, list);
}

function draw(host, list) {
  const bn = state.bnpl || [], today = ymd(new Date());
  const rows = schedule(list, listBnpl(), today).filter((r) => !r.paid || r.due >= shiftDays(today, -90));
  const accName = (id) => { const a = state.accountsById[id]; return a ? `${a.no} ${a.name}` : "？"; };
  host.innerHTML = `<section class="panel"><h3><span class="bar"></span>後払いの会社</h3>
    <p class="note">Paidy・メルペイスマート払いなどの後払いです。記帳で貸方を「41 未払費用」にして会社を選ぶと、締め日までに買った分が、引き落とし日の予定になります。</p>
    <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>会社</th><th>締め日</th><th>支払日</th><th>引き落とし口座</th><th>休日なら</th><th></th></tr></thead><tbody>
    ${bn.map((b) => `<tr><td>${esc(b.name)}${b.active === false ? ` <span class="muted">（使わない）</span>` : ""}</td><td>${b.closeDay ? b.closeDay + "日" : "月末"}</td><td>${b.payOffset === 0 ? "当月" : "翌月"}${b.payDay}日</td><td>${esc(accName(b.accId))}</td><td>${{ next: "次の平日", prev: "前の平日", none: "そのまま" }[b.holiday || "next"]}</td><td><button type="button" data-edit="${b.id}">直す</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">まだありません。</td></tr>`}
    </tbody></table></div>
    <div class="actions" style="justify-content:flex-start"><button type="button" id="bn-add">会社を追加</button>${bn.length ? "" : `<button type="button" id="bn-seed">Paidy・メルペイスマート払いを入れる</button>`}</div></section>
  <section class="panel"><h3><span class="bar"></span>引落の予定</h3>
    <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>会社</th><th>締め月</th><th>引き落とし日</th><th class="amt">予定額</th><th class="amt">実際</th><th class="amt">差</th><th>状態</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => { const dt = Math.round((Date.parse(r.due) - Date.parse(today)) / 86400000);
      const st = r.paid ? (r.diff ? `<span class="chip late">差があります</span>` : `<span class="chip biz">記帳済み</span>`) : !r.closed ? `<span class="muted">締め日（${esc(mdw(r.closeDate))}）前</span>` : dt < 0 ? `<span class="chip late">${-dt}日過ぎています</span>` : `<span class="chip late" style="background:#fff4e0">あと${dt}日</span>`;
      return `<tr><td>${esc(r.B.name)}</td><td>${parseInt(r.cycle.slice(5, 7), 10)}月分</td><td>${esc(mdw(r.due))}${r.why ? `<div class="note">（原則の日が${esc(r.why)}にあたるので調整）</div>` : ""}</td><td class="amt num">${yen(r.planned)}</td><td class="amt num">${r.paid ? yen(r.actual) : ""}</td><td class="amt num">${r.paid ? (r.diff > 0 ? "+" : "") + yen(r.diff) : ""}</td><td>${st}</td>
      <td>${r.paid ? `<button type="button" data-pay="${i}">直す</button>` : r.closed ? `<button type="button" data-pay="${i}">引き落としを記帳</button>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="8" class="muted">引落の予定はありません。</td></tr>`}
    </tbody></table></div>
    <p class="note">引き落としを記帳すると、借方 41 未払費用 ／ 貸方 引き落とし口座 の仕訳（種別：後払い）ができます。実際の額が予定と違うときは、差の理由を行追加で書いて、貸借を合わせます。</p></section>`;
  $("bn-add").addEventListener("click", () => editCompany(host, list, null));
  const seed = $("bn-seed");
  if (seed) seed.addEventListener("click", async () => {
    const bank = (accByNo(10) || {}).id || "";
    for (const [name, payDay] of [["Paidy", 27], ["メルペイスマート払い", 26]]) await setDoc(doc(col("bnpl"), "bn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4)), { name, closeDay: 0, payOffset: 1, payDay, accId: bank, holiday: "next", active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    renderBnpl();
  });
  host.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editCompany(host, list, bn.find((x) => x.id === b.dataset.edit))));
  host.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => payDialog(host, list, rows[+b.dataset.pay])));
}
const shiftDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

function editCompany(host, list, b) {
  const v = b || { name: "", closeDay: 0, payOffset: 1, payDay: 27, accId: (accByNo(10) || {}).id || "", holiday: "next", active: true };
  const banks = state.accounts.filter((a) => a.no <= 19 && !a.hidden).map((a) => `<option value="${a.id}"${a.id === v.accId ? " selected" : ""}>${esc(a.no + " " + a.name)}</option>`).join("");
  openModal(`<div class="dialog" role="dialog" aria-modal="true"><h3>${b ? "後払いの会社を直す" : "後払いの会社を追加"}</h3>
    <div class="vgrid" style="grid-template-columns:1fr 1fr;gap:8px">
      <div class="in"><label>会社の名前</label><input type="text" id="bn-name" value="${esc(v.name)}"></div>
      <div class="in"><label>締め日（空＝月末）</label><input type="number" id="bn-close" min="1" max="31" value="${v.closeDay || ""}"></div>
      <div class="in"><label>支払い</label><select id="bn-off"><option value="1"${v.payOffset !== 0 ? " selected" : ""}>翌月</option><option value="0"${v.payOffset === 0 ? " selected" : ""}>当月</option></select></div>
      <div class="in"><label>支払日（日）</label><input type="number" id="bn-day" min="1" max="31" value="${v.payDay}"></div>
      <div class="in"><label>引き落とし口座</label><select id="bn-acc">${banks}</select></div>
      <div class="in"><label>休日なら</label><select id="bn-hol"><option value="next"${(v.holiday || "next") === "next" ? " selected" : ""}>次の平日</option><option value="prev"${v.holiday === "prev" ? " selected" : ""}>前の平日</option><option value="none"${v.holiday === "none" ? " selected" : ""}>そのまま</option></select></div>
      <div class="in"><label><input type="checkbox" id="bn-act" ${v.active !== false ? "checked" : ""}> 使う</label></div></div>
    <p class="note" id="bn-msg"></p>
    <div class="actions"><button type="button" class="sub" id="bn-cancel">やめる</button><button type="button" class="primary" id="bn-save">保存</button></div></div>`);
  $("bn-cancel").addEventListener("click", closeModal);
  $("bn-save").addEventListener("click", async () => {
    const name = $("bn-name").value.trim();
    if (!name) { $("bn-msg").textContent = "会社の名前を入れてください。"; return; }
    const data = { name, closeDay: parseInt($("bn-close").value, 10) || 0, payOffset: parseInt($("bn-off").value, 10), payDay: parseInt($("bn-day").value, 10) || 27, accId: $("bn-acc").value, holiday: $("bn-hol").value, active: $("bn-act").checked, updatedAt: serverTimestamp() };
    try {
      if (b) await setDoc(doc(col("bnpl"), b.id), data, { merge: true });
      else await setDoc(doc(col("bnpl"), "bn_" + Date.now().toString(36)), { ...data, createdAt: serverTimestamp() });
      closeModal(); renderBnpl();
    } catch (err) { $("bn-msg").textContent = "保存に失敗しました：" + (err.code || err.message); }
  });
}

// 引き落としの記帳（予定どおりでも、差があっても。差は「行を追加」で理由を書く）
export function buildPayLines(B, planned, actual, extras) {
  const a41 = accByNo(41), memo = "後払い引き落とし";
  const lines = [];
  const push = (side, accId, amount, m) => { if (accId && amount) lines.push({ side, accId, amount, tax: 0, memo: m || "", tags: [], biz: "life" }); };
  push("debit", a41.id, planned, memo);
  push("credit", B.accId, actual, memo);
  (extras || []).forEach((e) => push(e.side, e.accId, Math.round(Number(e.amount) || 0), e.memo || "差額"));
  const debit = lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0), credit = lines.filter((l) => l.side === "credit").reduce((x, l) => x + l.amount, 0);
  return { lines, debit, credit, balanced: debit === credit && debit > 0 };
}

function payDialog(host, list, r) {
  const B = r.B, ex = r.voucher;
  const st = { date: ex ? ex.date : r.due, actual: ex ? r.actual : r.planned, extras: ex ? (ex.lines || []).filter((l, i) => !(l.accId === accByNo(41).id && l.side === "debit" && i === 0) && !(i === 1 && l.side === "credit" && l.accId === B.accId)).map((l) => ({ side: l.side, accId: l.accId, amount: l.amount, memo: l.memo })) : [] };
  const opt = (sel) => state.accounts.map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${esc(a.no + " " + a.name)}</option>`).join("");
  const cyc = `${parseInt(r.cycle.slice(5, 7), 10)}月分`;
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true"><h3>${esc(B.name)} ${cyc}の引き落とし</h3>
    <div class="vgrid" style="grid-template-columns:1fr 1fr 1fr;gap:8px">
      <div class="in"><label>引き落とし日</label><input type="date" id="bp-date" value="${esc(st.date)}"></div>
      <div class="in"><label>予定額（41 未払費用を消す額）</label><div class="box">¥${yen(r.planned)}</div></div>
      <div class="in"><label>実際に引き落とされた額</label><input type="text" inputmode="numeric" id="bp-act" value="${st.actual}" style="text-align:right"></div></div>
    <p class="note" id="bp-diff"></p>
    <div id="bp-extra"></div>
    <div class="actions" style="justify-content:flex-start"><button type="button" class="sub" id="bp-addx">差額の行を追加</button></div>
    <table class="tbl mtbl"><thead><tr><th>借方</th><th class="amt">金額</th><th>貸方</th><th class="amt">金額</th></tr></thead><tbody id="bp-prev"></tbody></table>
    <p class="note" id="bp-bal"></p><p class="note" id="bp-msg"></p>
    <div class="actions"><button type="button" class="sub" id="bp-cancel">やめる</button><button type="button" class="primary" id="bp-save">${ex ? "記帳し直す" : "記帳する"}</button></div></div>`);
  const nm = (id) => { const a = state.accountsById[id]; return a ? `${a.no} ${a.name}` : "？"; };
  const parse = (s) => { const n = Number(String(s).replace(/[,，\s¥円]/g, "")); return Number.isFinite(n) ? Math.round(n) : 0; };
  const drawX = () => {
    $("bp-extra").innerHTML = st.extras.map((e, i) => `<div class="toolbar"><select data-xi="${i}" data-f="side"><option value="debit"${e.side === "debit" ? " selected" : ""}>借方</option><option value="credit"${e.side === "credit" ? " selected" : ""}>貸方</option></select>
      <select data-xi="${i}" data-f="acc"><option value="">科目を選ぶ</option>${opt(e.accId)}</select><input type="text" inputmode="numeric" placeholder="金額" data-xi="${i}" data-f="amt" value="${e.amount || ""}" style="width:100px;text-align:right"><input type="text" placeholder="差額の理由（例：手数料）" data-xi="${i}" data-f="memo" value="${esc(e.memo || "")}"><button type="button" data-xdel="${i}">削除</button></div>`).join("");
    $("bp-extra").querySelectorAll("[data-xi]").forEach((x) => x.addEventListener(x.tagName === "SELECT" ? "change" : "input", () => {
      const e = st.extras[+x.dataset.xi], f = x.dataset.f;
      if (f === "side") e.side = x.value; else if (f === "acc") e.accId = x.value; else if (f === "amt") e.amount = parse(x.value) || ""; else e.memo = x.value;
      calc();
    }));
    $("bp-extra").querySelectorAll("[data-xdel]").forEach((x) => x.addEventListener("click", () => { st.extras.splice(+x.dataset.xdel, 1); drawX(); calc(); }));
  };
  const calc = () => {
    const res = buildPayLines(B, r.planned, st.actual, st.extras), diff = st.actual - r.planned;
    $("bp-diff").textContent = diff ? `予定との差：${diff > 0 ? "+" : "−"}¥${yen(Math.abs(diff))}。理由を、下の「差額の行を追加」に書いてください（例：手数料なら借方 75 雑費）。` : "予定どおりです。";
    const ds = res.lines.filter((l) => l.side === "debit"), cs = res.lines.filter((l) => l.side === "credit");
    $("bp-prev").innerHTML = Array.from({ length: Math.max(ds.length, cs.length) }, (_, i) => `<tr><td>${ds[i] ? esc(nm(ds[i].accId)) : ""}</td><td class="amt num">${ds[i] ? yen(ds[i].amount) : ""}</td><td>${cs[i] ? esc(nm(cs[i].accId)) : ""}</td><td class="amt num">${cs[i] ? yen(cs[i].amount) : ""}</td></tr>`).join("") + `<tr class="tot"><td>借方合計</td><td class="amt num">${yen(res.debit)}</td><td>貸方合計</td><td class="amt num">${yen(res.credit)}</td></tr>`;
    $("bp-bal").textContent = res.balanced ? "✓ 借方と貸方が合っています" : `借方と貸方が ¥${yen(Math.abs(res.debit - res.credit))} 違います（合うまで記帳できません）`;
    return res;
  };
  drawX(); calc();
  $("bp-act").addEventListener("input", (e) => { st.actual = parse(e.target.value); calc(); });
  $("bp-date").addEventListener("change", (e) => { st.date = e.target.value; });
  $("bp-addx").addEventListener("click", () => { const diff = st.actual - r.planned; st.extras.push(diff > 0 ? { side: "debit", accId: (accByNo(75) || {}).id || "", amount: diff, memo: "" } : diff < 0 ? { side: "credit", accId: (accByNo(49) || {}).id || "", amount: -diff, memo: "" } : { side: "debit", accId: "", amount: "", memo: "" }); drawX(); calc(); });
  $("bp-cancel").addEventListener("click", closeModal);
  $("bp-save").addEventListener("click", async () => {
    const res = calc(), msg = $("bp-msg");
    if (!st.date) { msg.textContent = "引き落とし日を入れてください。"; return; }
    if (!res.balanced) { msg.textContent = "借方と貸方が合っていません。"; return; }
    if (st.extras.some((e) => e.amount && !e.accId)) { msg.textContent = "追加した行の科目を選んでください。"; return; }
    const month = monthOf(st.date);
    if (isClosed(month)) { msg.textContent = `${month}は締めてあります。月末の画面で締めを外してから記帳してください。`; return; }
    try {
      const id = payId(B, r.cycle);
      let seq = ex ? ex.seq : 0;
      if (!seq) { const l = await fetchMonthVouchers(month); seq = Math.max(l.maxSeqAll || 0, ...l.map((x) => x.seq || 0)) + 1; }
      const today = ymd(new Date());
      await setDoc(doc(col("vouchers"), id), {
        month, seq, date: st.date, entryDate: ex ? ex.entryDate || today : today, late: today > st.date, fieldId: "", partyId: B.partyId || "", mark: "",
        kind: "bnpl", batchId: `bnpl-${r.cycle}`, payVia: B.id, cycle: r.cycle, lines: res.lines, updatedAt: serverTimestamp(), ...(ex ? {} : { createdAt: serverTimestamp() })
      }, { merge: true });
      state.allVouchers = null; await loadVouchers(); closeModal(); renderBnpl();
    } catch (err) { console.error("[後払い]", err); msg.textContent = "記帳に失敗しました：" + (err.code || err.message); }
  });
}
