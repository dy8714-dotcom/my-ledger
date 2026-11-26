// 定期支払（I7a）：☆定額・★変動・◇年払い・◆外貨 の登録と、記帳画面の「未記帳のお知らせ」
import { state, col, db, loadRecurring, loadAllVouchers } from "./state.js?v=0.2I8e";
import { $, esc, hk, yen, parseAmount, ymd, openModal, closeModal, showError } from "./util.js?v=0.2I8e";
import { doc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { fromTemplate } from "./patterns.js?v=0.2I8e";
import { offReason, shiftBusiness } from "./holidays.js?v=0.2I8e";

export const MARKS = ["☆", "★", "◇", "◆"];
const MARK_NAME = { "☆": "定額・毎月", "★": "金額が変わる・毎月", "◇": "年払い", "◆": "外貨建て・毎月" };
const KIND_NAME = { fixed: "固定費", regular: "定期の支出" };

// ---------- 月・日の計算（月度は "26.11" の形） ----------
const ymOf = (m) => { const [yy, mm] = m.split(".").map((x) => parseInt(x, 10)); return `${2000 + yy}-${String(mm).padStart(2, "0")}`; };
const monthNo = (m) => parseInt(m.split(".")[1], 10);
const daysIn = (m) => { const [yy, mm] = m.split(".").map((x) => parseInt(x, 10)); return new Date(2000 + yy, mm, 0).getDate(); };

// その月度に、この定期支払があるか（開始月・終了月・年払いの月）
export function isDue(rec, month) {
  if (rec.active === false) return false;
  const ym = ymOf(month);
  if (rec.start && ym < rec.start) return false;
  if (rec.end && ym > rec.end) return false;
  if (rec.mark === "◇" && rec.payMonth && monthNo(month) !== Number(rec.payMonth)) return false;
  return true;
}

// 決めた日（31日指定、またはその月にない日は月末）
export function baseDate(rec, month) {
  const d = Math.min(Math.max(parseInt(rec.day, 10) || 1, 1), daysIn(month));
  return `${ymOf(month)}-${String(d).padStart(2, "0")}`;
}

// 休日の扱い：決まっていなければ「次の平日」（定期収入を作るときは「前の平日」にする予定）
export const holidayRule = (rec) => (rec.holiday === "prev" || rec.holiday === "none" ? rec.holiday : "next");

// 引き落とし日（土日祝・年末年始なら、休日の扱いに合わせてずらした日）
export function dueDate(rec, month) {
  return shiftBusiness(baseDate(rec, month), holidayRule(rec));
}

// ずらしたときの理由（ずらしていなければ空）
export function shiftReason(rec, month) {
  const b = baseDate(rec, month);
  return dueDate(rec, month) === b ? "" : offReason(b);
}

// ルールの説明文（備考の自動入力にも使う）
export function explainRule(rec) {
  const when = rec.mark === "◇" ? `毎年${rec.payMonth || "?"}月` : "毎月";
  const day = parseInt(rec.day, 10) >= 31 ? "末日" : `${parseInt(rec.day, 10) || "?"}日`;
  const rule = holidayRule(rec);
  return `${when}${day}${rule === "next" ? "（土日祝・年末年始は翌平日）" : rule === "prev" ? "（土日祝・年末年始は前の平日）" : ""}`;
}

// 記帳済みか：この定期支払から記帳した仕訳（recId）、または同じ取引先（なければ同じ借方・貸方）の仕訳がその月度にある
export function isDone(rec, vouchers) {
  return vouchers.some((v) => {
    if (v.deleted) return false;
    if (v.recId === rec.id) return true;
    if (v.recId) return false;
    if (rec.partyId) return v.partyId === rec.partyId && (!rec.mark || v.mark === rec.mark || !v.mark);
    const dl = (v.lines || []).some((l) => l.side === "debit" && l.accId === rec.debitId);
    const cl = (v.lines || []).some((l) => l.side === "credit" && l.accId === rec.creditId);
    return dl && cl && (!rec.mark || v.mark === rec.mark);
  });
}

export function monthStatus(recs, month, vouchers, today) {
  return recs.filter((r) => isDue(r, month)).map((r) => {
    const date = dueDate(r, month);
    const done = isDone(r, vouchers);
    return { rec: r, date, base: baseDate(r, month), reason: shiftReason(r, month), done, overdue: !done && date < today };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// 毎月かかる金額の目安：固定費（☆★◆）の月額合計、◇は12か月に均した額
export function monthlyTotals(recs) {
  let fixedMonthly = 0, yearlyAvg = 0, regular = 0;
  recs.filter((r) => r.active !== false && !r.end).forEach((r) => {
    const a = Number(r.amount) || 0;
    if (r.kind === "regular") regular += r.mark === "◇" ? a / 12 : a;
    else if (r.mark === "◇") yearlyAvg += a / 12;
    else fixedMonthly += a;
  });
  return { fixedMonthly, yearlyAvg: Math.round(yearlyAvg), regular: Math.round(regular) };
}

// ---------- 過去の仕訳から候補を作る ----------
export function buildCandidates(vouchers, recs, accountsById) {
  const groups = new Map();
  vouchers.forEach((v) => {
    if (v.deleted || !MARKS.includes(v.mark)) return;
    const d = (v.lines || []).filter((l) => l.side === "debit"), c = (v.lines || []).filter((l) => l.side === "credit");
    if (d.length < 1 || c.length < 1) return;
    const memo = (v.lines.map((l) => l.memo).find((m) => m) || "");
    const key = v.mark + "|" + (v.partyId || memo || d[0].accId);
    const g = groups.get(key) || { key, list: [] };
    g.list.push(v);
    groups.set(key, g);
  });
  const out = [];
  groups.forEach((g) => {
    const last = g.list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const d = last.lines.filter((l) => l.side === "debit"), c = last.lines.filter((l) => l.side === "credit");
    const pl = last.lines.find((l) => { const a = accountsById[l.accId]; return a && (a.kind === "expense" || a.kind === "revenue"); });
    if (recs.some((r) => r.mark === last.mark && ((last.partyId && r.partyId === last.partyId) || (!last.partyId && r.debitId === d[0].accId && r.creditId === c[0].accId)))) return;
    const partyName = last.partyId && (accountsById.__parties || {})[last.partyId];
    out.push({
      key: g.key, count: g.list.length, mark: last.mark, partyId: last.partyId || "", fieldId: last.fieldId || "",
      name: partyName || (last.lines.map((l) => l.memo).find((m) => m) || (accountsById[d[0].accId] || {}).name || "（名前なし）"),
      amount: d.reduce((s, l) => s + l.amount, 0), day: parseInt(String(last.date).slice(8, 10), 10) || 1,
      payMonth: parseInt(String(last.date).slice(5, 7), 10) || 1,
      debitId: d[0].accId, creditId: c[0].accId, tax: d[0].tax || 0, biz: pl && pl.biz === "biz" ? "biz" : "life",
      memo: "", lastDate: last.date
    });
  });
  return out.sort((a, b) => (a.mark === b.mark ? a.day - b.day : MARKS.indexOf(a.mark) - MARKS.indexOf(b.mark)));
}

// ---------- 設定の「定期支払」タブ ----------
const accOpts = (sel, filter) => `<option value="">選んでください</option>` + state.accounts.filter((a) => !a.hidden && (!filter || filter(a)))
  .sort((x, y) => x.no - y.no).map((a) => `<option value="${esc(a.id)}"${a.id === sel ? " selected" : ""}>${esc(a.no)} ${esc(a.name)}</option>`).join("");
const nm = (id) => { const a = state.accountsById[id]; return a ? `${a.no} ${a.name}` : "？"; };
const partyName = (id) => { const p = state.partiesById[id]; return p ? hk(p.name) : ""; };

export async function renderRecurring() {
  const host = $("settings-body");
  const recs = state.recurring;
  const t = monthlyTotals(recs);
  const rows = recs.map((r) => `<tr data-id="${esc(r.id)}" class="${r.active === false || r.end ? "off" : ""}">
    <td class="num">${esc(r.mark || "")}</td><td>${esc(r.name)}</td>
    <td class="amt num">${r.mark === "◆" && r.usd ? `$${esc(r.usd)} ≒ ` : ""}${r.mark === "★" ? "約" : ""}${yen(r.amount || 0)}</td>
    <td class="num">${r.mark === "◇" ? esc(r.payMonth || "") + "月" : "毎月"}${esc(r.day)}日</td>
    <td>${esc(KIND_NAME[r.kind] || "固定費")}</td><td>${esc(nm(r.debitId))}</td><td>${esc(nm(r.creditId))}</td>
    <td class="sub2">${esc(r.note || explainRule(r))}</td><td class="num">${esc((r.start || "") + (r.start || r.end ? "〜" : "") + (r.end || ""))}</td>
    <td><button type="button" class="sub" data-act="edit">修正</button> <button type="button" class="sub" data-act="end">${r.active === false || r.end ? "再開" : "終了"}</button></td></tr>`).join("");
  host.innerHTML = `
    <section class="panel">
      <h3><span class="bar"></span>定期支払</h3>
      <p class="note">毎月（または毎年）決まって払うものを登録します。記帳画面に「今月の定期支払」が出て、支払日を過ぎても記帳していないものを知らせます。記帳のボタンを押すと、入力欄に内容が入るので、金額を確かめて登録してください（勝手には登録されません）。</p>
      <div class="toolbar">
        <button type="button" class="sub" id="rc-add">＋ 新しい定期支払</button>
        <button type="button" class="sub" id="rc-cand">過去の ☆★◇◆ の仕訳から候補を作る</button>
        <span class="count">固定費 月額 ¥${yen(t.fixedMonthly)}　＋　年払いの月割り ¥${yen(t.yearlyAvg)}${t.regular ? `　／　定期の支出 ¥${yen(t.regular)}` : ""}</span>
      </div>
      <div class="tablewrap"><table class="tbl" style="min-width:0"><thead><tr><th>印</th><th>名前</th><th class="amt">金額</th><th>支払日</th><th>区分</th><th>借方</th><th>貸方（支払元）</th><th>備考</th><th>期間</th><th></th></tr></thead>
        <tbody id="rc-body">${rows || `<tr><td colspan="10" class="empty">まだ登録がありません。「過去の ☆★◇◆ の仕訳から候補を作る」で、いまの記帳から自動で拾えます。</td></tr>`}</tbody></table></div>
      <p class="note">★の金額は目安、◆はドル額と円の目安です。「終了」しても履歴は残ります。</p>
    </section>`;
  $("rc-add").addEventListener("click", () => openForm(null));
  $("rc-cand").addEventListener("click", openCandidates);
  $("rc-body").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const r = recs.find((x) => x.id === b.closest("tr").dataset.id);
    if (!r) return;
    if (b.dataset.act === "edit") return openForm(r);
    try {
      const ending = !(r.active === false || r.end);
      await setDoc(doc(col("recurring"), r.id), ending ? { active: false, end: ymOf(state.month || "26.1") , updatedAt: serverTimestamp() } : { active: true, end: "", updatedAt: serverTimestamp() }, { merge: true });
      await loadRecurring(); renderRecurring();
    } catch (err) { showError("保存に失敗しました：" + (err.code || err.message)); }
  });
}

function openForm(r) {
  const isNew = !r;
  const v = r || { mark: "☆", day: 1, kind: "fixed", tax: 0, biz: "life", amount: "", payMonth: 1 };
  const fieldOpts = `<option value="">なし</option>` + state.fields.filter((f) => !f.hidden).map((f) => `<option value="${esc(f.id)}"${f.id === v.fieldId ? " selected" : ""}>${esc(f.no)} ${esc(hk(f.name))}</option>`).join("");
  const partyOpts = `<option value="">なし</option>` + [...state.parties].filter((p) => !p.hidden).sort((a, b) => String(a.kana || a.name).localeCompare(String(b.kana || b.name), "ja"))
    .map((p) => `<option value="${esc(p.id)}"${p.id === v.partyId ? " selected" : ""}>${esc(hk(p.name))}</option>`).join("");
  openModal(`<div class="dialog" role="dialog" aria-modal="true" style="max-width:640px">
    <h2>${isNew ? "定期支払を登録" : "定期支払を修正"}</h2>
    <div class="fgrid">
      <label>名前<input type="text" data-k="name" value="${esc(v.name || "")}" placeholder="例：株探プレミアム"></label>
      <label>印<select data-k="mark">${MARKS.map((m) => `<option value="${m}"${m === v.mark ? " selected" : ""}>${m} ${MARK_NAME[m]}</option>`).join("")}</select></label>
      <label data-w="usd">ドル額（◆のとき）<input type="text" inputmode="decimal" data-k="usd" value="${esc(v.usd || "")}"></label>
      <label>金額（円）<span class="note" data-k="amtnote"></span><input type="text" inputmode="numeric" data-k="amount" value="${esc(v.amount || "")}"></label>
      <label>支払日（31＝月末）<input type="text" inputmode="numeric" data-k="day" value="${esc(v.day)}"></label>
      <label data-w="paym">年払いの月（◇のとき）<select data-k="payMonth">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${Number(v.payMonth) === i + 1 ? " selected" : ""}>${i + 1}月</option>`).join("")}</select></label>
      <label>借方（経費など）<select data-k="debitId">${accOpts(v.debitId)}</select></label>
      <label>貸方（支払元）<select data-k="creditId">${accOpts(v.creditId)}</select></label>
      <label>分野<select data-k="fieldId">${fieldOpts}</select></label>
      <label>取引先<select data-k="partyId">${partyOpts}</select></label>
      <label>税率<select data-k="tax">${[0, 8, 10].map((t) => `<option value="${t}"${Number(v.tax) === t ? " selected" : ""}>${t ? t + "%" : "ー"}</option>`).join("")}</select></label>
      <label>事業／生活<select data-k="biz"><option value="life"${v.biz !== "biz" ? " selected" : ""}>生活</option><option value="biz"${v.biz === "biz" ? " selected" : ""}>事業</option></select></label>
      <label>休日の扱い<select data-k="holiday"><option value="next"${holidayRule(v) === "next" ? " selected" : ""}>土日祝・年末年始なら、次の平日にずらす</option><option value="prev"${holidayRule(v) === "prev" ? " selected" : ""}>土日祝・年末年始なら、前の平日にずらす</option><option value="none"${holidayRule(v) === "none" ? " selected" : ""}>ずらさない（そのままの日）</option></select></label>
      <label>区分<select data-k="kind"><option value="fixed"${v.kind !== "regular" ? " selected" : ""}>固定費（P/Lの経費）</option><option value="regular"${v.kind === "regular" ? " selected" : ""}>定期の支出（借入金返済・生活費支給など）</option></select></label>
      <label>開始月（空でもOK）<input type="month" data-k="start" value="${esc(v.start || "")}"></label>
      <label>終了月（空でもOK）<input type="month" data-k="end" value="${esc(v.end || "")}"></label>
      <label style="grid-column:1/-1">備考（自由に書けます。空なら、ルールの説明が自動で出ます）
        <span style="display:flex;gap:6px"><input type="text" data-k="note" value="${esc(v.note || "")}" style="flex:1"><button type="button" class="sub" id="rc-autonote">ルールから自動で入れる</button></span></label>
      <label style="grid-column:1/-1">摘要（空なら名前。{M/D} は支払日に置き換わります）<input type="text" data-k="memo" value="${esc(v.memo || "")}"></label>
    </div>
    <p class="note" id="rc-msg"></p>
    <div class="actions">${isNew ? "" : `<button type="button" class="danger" id="rc-del">削除</button>`}
      <button type="button" class="sub" id="rc-cancel">やめる</button><button type="button" class="primary" id="rc-ok">保存</button></div></div>`);
  const m = $("modal");
  const q = (k) => m.querySelector(`[data-k="${k}"]`);
  const sync = () => {
    const mk = q("mark").value;
    m.querySelector('[data-w="usd"]').hidden = mk !== "◆";
    m.querySelector('[data-w="paym"]').hidden = mk !== "◇";
    q("amtnote").textContent = mk === "★" ? "（目安）" : mk === "◆" ? "（円の目安）" : "";
  };
  q("mark").addEventListener("change", sync); sync();
  $("rc-autonote").addEventListener("click", () => {
    q("note").value = explainRule({ mark: q("mark").value, day: q("day").value, payMonth: q("payMonth").value, holiday: q("holiday").value });
  });
  $("rc-cancel").addEventListener("click", closeModal);
  if (!isNew) $("rc-del").addEventListener("click", async () => {
    if (!confirm(`「${v.name}」を削除します。記帳済みの仕訳は消えません。よろしいですか？（やめるときは「終了」にしてください）`)) return;
    try { await deleteDoc(doc(col("recurring"), r.id)); await loadRecurring(); closeModal(); renderRecurring(); } catch (err) { $("rc-msg").textContent = "削除に失敗しました：" + (err.code || err.message); }
  });
  $("rc-ok").addEventListener("click", async () => {
    const data = {
      name: q("name").value.trim(), mark: q("mark").value, usd: q("usd").value.trim(), amount: parseAmount(q("amount").value),
      day: parseInt(q("day").value, 10), payMonth: parseInt(q("payMonth").value, 10), debitId: q("debitId").value, creditId: q("creditId").value,
      fieldId: q("fieldId").value, partyId: q("partyId").value, tax: parseInt(q("tax").value, 10), biz: q("biz").value, kind: q("kind").value, holiday: q("holiday").value, note: q("note").value.trim(),
      start: q("start").value, end: q("end").value, memo: q("memo").value.trim()
    };
    const err = !data.name ? "名前を入れてください。" : !(data.amount > 0) ? "金額（円）は1円以上で入れてください。" : !(data.day >= 1 && data.day <= 31) ? "支払日は1〜31で入れてください。"
      : !data.debitId ? "借方の科目を選んでください。" : !data.creditId ? "貸方（支払元）を選んでください。" : data.debitId === data.creditId ? "借方と貸方に同じ科目は使えません。" : "";
    if (err) { $("rc-msg").textContent = err; return; }
    data.active = !data.end;
    try {
      const id = isNew ? "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) : r.id;
      await setDoc(doc(col("recurring"), id), { ...data, updatedAt: serverTimestamp(), ...(isNew ? { createdAt: serverTimestamp() } : {}) }, { merge: true });
      await loadRecurring(); closeModal(); renderRecurring();
    } catch (e2) { $("rc-msg").textContent = "保存に失敗しました：" + (e2.code || e2.message); }
  });
}

async function openCandidates() {
  openModal(`<div class="dialog" role="dialog" aria-modal="true"><h2>候補を作っています…</h2><p class="note">全期間の仕訳から、☆★◇◆の印が付いたものを探しています。</p></div>`);
  let cands;
  try {
    const all = await loadAllVouchers();
    const acc = { ...state.accountsById, __parties: Object.fromEntries(state.parties.map((p) => [p.id, hk(p.name)])) };
    cands = buildCandidates(all, state.recurring, acc);
  } catch (err) { closeModal(); showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (!cands.length) {
    openModal(`<div class="dialog"><h2>候補はありません</h2><p class="note">☆★◇◆の印が付いた仕訳がないか、すべて登録済みです。</p><div class="actions"><button type="button" class="primary" id="cd-close">閉じる</button></div></div>`);
    $("cd-close").addEventListener("click", closeModal);
    return;
  }
  openModal(`<div class="dialog" role="dialog" aria-modal="true" style="max-width:720px"><h2>候補 ${cands.length}件</h2>
    <p class="note">いまの記帳の、印が付いた仕訳から拾いました。登録するものにチェックを入れてください（登録のあと、設定の一覧で修正できます）。金額は直近の記帳の金額です。</p>
    <div style="max-height:340px;overflow:auto"><table class="tbl" style="min-width:0"><thead><tr><th></th><th>印</th><th>名前</th><th class="amt">金額</th><th>支払日</th><th>借方</th><th>貸方</th><th>回数</th></tr></thead><tbody>
    ${cands.map((c, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td>${esc(c.mark)}</td><td>${esc(c.name)}</td><td class="amt num">${yen(c.amount)}</td>
      <td class="num">${c.mark === "◇" ? c.payMonth + "月" : ""}${c.day}日</td><td>${esc(nm(c.debitId))}</td><td>${esc(nm(c.creditId))}</td><td class="num">${c.count}</td></tr>`).join("")}
    </tbody></table></div><p class="note" id="cd-msg"></p>
    <div class="actions"><button type="button" class="sub" id="cd-cancel">やめる</button><button type="button" class="primary" id="cd-ok">選んだ分を登録</button></div></div>`);
  $("cd-cancel").addEventListener("click", closeModal);
  $("cd-ok").addEventListener("click", async () => {
    const pick = [...$("modal").querySelectorAll("input[data-i]:checked")].map((x) => cands[Number(x.dataset.i)]);
    if (!pick.length) { $("cd-msg").textContent = "登録するものにチェックを入れてください。"; return; }
    $("cd-ok").disabled = true;
    try {
      const wb = writeBatch(db);
      pick.forEach((c, i) => {
        const id = "r_" + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 4);
        wb.set(doc(col("recurring"), id), { name: c.name, mark: c.mark, usd: "", amount: c.amount, day: c.day, payMonth: c.payMonth, debitId: c.debitId, creditId: c.creditId,
          fieldId: c.fieldId, partyId: c.partyId, tax: c.tax, biz: c.biz, kind: "fixed", start: "", end: "", memo: c.memo, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      });
      await wb.commit();
      await loadRecurring(); closeModal(); renderRecurring();
    } catch (err) { $("cd-msg").textContent = "登録に失敗しました：" + (err.code || err.message); $("cd-ok").disabled = false; }
  });
}

// ---------- 記帳画面の「今月の定期支払」 ----------
export function renderRecBanner(el, onDraft) {
  if (!el) return;
  const recs = state.recurring || [];
  if (!recs.length) { el.hidden = true; el.innerHTML = ""; return; }
  const today = ymd(new Date());
  const st = monthStatus(recs, state.month, state.vouchers, today);
  const todo = st.filter((s) => !s.done);
  if (!st.length) { el.hidden = true; el.innerHTML = ""; return; }
  const over = todo.filter((s) => s.overdue).length;
  const md = (d) => `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`;
  el.hidden = false;
  el.className = "bkbanner rcbanner" + (over ? " warn" : "");
  el.innerHTML = `<details ${over ? "open" : ""}><summary><strong>${esc(state.month)}月度の定期支払</strong>　${todo.length ? `未記帳 ${todo.length}件${over ? `（うち支払日を過ぎたもの ${over}件）` : ""}` : "すべて記帳済み ✓"}　<span class="note">全${st.length}件</span></summary>
    <table class="tbl" style="min-width:0;margin-top:6px"><tbody>${st.map((s, i) => `<tr class="${s.done ? "done" : s.overdue ? "over" : ""}">
      <td class="num">${esc(s.rec.mark || "")}</td><td>${esc(s.rec.name)}</td><td class="num">${md(s.date)}${s.reason ? `<span class="chg">${md(s.base)} ${esc(s.reason)}のため</span>` : ""}</td>
      <td class="amt num">${s.rec.mark === "★" || s.rec.mark === "◆" ? "約" : ""}${yen(s.rec.amount || 0)}</td>
      <td>${s.done ? "記帳済み ✓" : s.overdue ? `<span class="late-txt">支払日を過ぎています</span>` : "予定"}</td>
      <td class="sub2">${esc(s.rec.note || explainRule(s.rec))}</td>
      <td>${s.done ? "" : `<button type="button" class="sub" data-i="${i}">記帳する</button>`}</td></tr>`).join("")}</tbody></table></details>`;
  el.querySelectorAll("button[data-i]").forEach((b) => b.addEventListener("click", () => {
    const s = st[Number(b.dataset.i)];
    onDraft({
      recId: s.rec.id, date: s.date, debitId: s.rec.debitId, creditId: s.rec.creditId, fieldId: s.rec.fieldId || "", partyId: s.rec.partyId || "",
      amount: s.rec.amount || 0, tax: s.rec.tax || 0, mark: s.rec.mark || "", biz: s.rec.biz || "life", memo: fromTemplate(s.rec.memo || s.rec.name, s.date)
    });
  }));
}
