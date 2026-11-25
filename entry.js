// 記帳画面（入力欄と仕訳の一覧）
import { state, col, loadParties, loadVouchers, fetchMonthVouchers } from "./state.js?v=0.1D1";
import { $, esc, norm, hk, yen, parseAmount, WD, ymd, monthOf, shiftMonth, firstDayOf, accChip, openModal, closeModal }
  from "./util.js?v=0.1D1";
import { createCombo } from "./combo.js?v=0.1D1";
import { doc, setDoc, updateDoc, deleteDoc, serverTimestamp, increment, arrayUnion }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

// ---------- 候補の作り方 ----------
const isBlank = (a) => a.name.startsWith("（") || a.name === "ー";

function accountItems() {
  return state.accounts.filter((a) => !a.hidden && !isBlank(a)).map((a) => ({
    id: a.id, no: a.no, name: a.name, kana: a.kana || "", count: 0, boost: false, html: accChip(a)
  }));
}

function fieldItems() {
  return state.fields.filter((f) => !f.hidden).map((f) => ({
    id: f.id, no: f.no, name: f.name, kana: "", count: 0, boost: false,
    html: `<span class="fd"><b>${esc(f.no)}</b>${esc(hk(f.name))}</span>`
  }));
}

function partyItems(fieldId) {
  return state.parties.filter((p) => !p.hidden).map((p) => ({
    id: p.id, no: null, name: p.name, kana: p.kana || "", count: p.count || 0,
    boost: !!(fieldId && (p.fieldIds || []).includes(fieldId)),
    html: `<span class="pn">${esc(hk(p.name))}</span><span class="cnt">${p.count || 0}回</span>`
  }));
}

const accLabel = (id) => {
  const a = state.accountsById[id];
  return a ? `${a.no} ${a.name}` : "";
};
const fieldLabel = (id) => {
  const f = state.fieldsById[id];
  return f ? `${f.no} ${hk(f.name)}` : "";
};
const partyLabel = (id) => {
  const p = state.partiesById[id];
  return p ? hk(p.name) : "";
};

function maxSeq(list) {
  return list.reduce((m, v) => Math.max(m, v.seq || 0), 0);
}

function defaultDate() {
  if (state.lastDate && monthOf(state.lastDate) === state.month) return state.lastDate;
  const t = ymd(new Date());
  return monthOf(t) === state.month ? t : firstDayOf(state.month);
}

function isSimple(v) {
  const d = v.lines.filter((l) => l.side === "debit");
  const c = v.lines.filter((l) => l.side === "credit");
  return d.length === 1 && c.length === 1;
}

// ---------- 入力フォーム（上の入力欄と、修正の画面で共通） ----------
function mountVoucherForm(root, { voucher = null, onSaved, onCancel, onDeleted }) {
  const isEdit = !!voucher;
  root.innerHTML = `
    <div class="vgrid">
      <div class="in c2"><label>日付</label><input type="date" data-k="date"></div>
      <div class="in c1"><label>伝番</label><div class="box seq" data-k="seq"></div></div>
      <div class="in c1"><label>税率</label>
        <select data-k="tax"><option value="0">ー</option><option value="8">8%</option><option value="10">10%</option></select></div>
      <div class="in c2"><label>借方</label><div data-k="debit"></div></div>
      <div class="in c2"><label>貸方</label><div data-k="credit"></div></div>
      <div class="in c2"><label>分野</label><div data-k="field"></div></div>
      <div class="in c2"><label>取引先</label><div data-k="party"></div></div>
      <div class="in c7"><label>摘要</label><input type="text" data-k="memo" autocomplete="off"></div>
      <div class="in c2"><label>金額</label><input type="text" inputmode="numeric" data-k="amount" class="amt" autocomplete="off"></div>
      <div class="in c1"><label>印</label>
        <select data-k="mark"><option value="">ー</option><option>☆</option><option>★</option><option>◇</option><option>◆</option></select></div>
    </div>
    <div class="vactions">
      <button type="button" class="primary" data-k="save">${isEdit ? "保存" : "登録"}</button>
      ${isEdit ? '<button type="button" class="sub" data-k="cancel">キャンセル</button>' : ""}
      ${isEdit ? '<button type="button" class="danger" data-k="delete">削除</button>' : ""}
      <span class="vmsg" data-k="msg"></span>
      <span class="note hint">${isEdit ? "" : "Enter：次の欄へ（金額でEnter：登録）　番号・よみ・文字で絞り込めます"}</span>
    </div>`;
  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  const dateEl = q("date"), seqEl = q("seq"), taxEl = q("tax"), memoEl = q("memo");
  const amountEl = q("amount"), markEl = q("mark"), msgEl = q("msg"), saveBtn = q("save");
  let taxTouched = false;

  const msg = (m) => { msgEl.textContent = m || ""; };

  function updateSeq() {
    const m = monthOf(dateEl.value || ymd(new Date()));
    if (isEdit) seqEl.textContent = `${voucher.month}-${voucher.seq}`;
    else if (m === state.month) seqEl.textContent = `${m}-${maxSeq(state.vouchers) + 1}`;
    else seqEl.textContent = `${m}-自動`;
  }

  function defaultTax() {
    if (taxTouched) return;
    const d = state.accountsById[debit.getValue().id];
    const c = state.accountsById[credit.getValue().id];
    taxEl.value = String((d && d.tax) || (c && c.tax) || 0);
  }

  const order = () => [dateEl, taxEl, debit.input, credit.input, field.input, party.input, memoEl, amountEl, markEl];
  function focusNext(el) {
    const list = order();
    const i = list.indexOf(el);
    if (i >= 0 && i < list.length - 1) list[i + 1].focus();
  }

  const debit = createCombo(q("debit"), {
    getItems: accountItems, labelOf: accLabel,
    onChange: defaultTax, onEnter: () => focusNext(debit.input)
  });
  const credit = createCombo(q("credit"), {
    getItems: accountItems, labelOf: accLabel,
    onChange: defaultTax, onEnter: () => focusNext(credit.input)
  });
  const field = createCombo(q("field"), {
    getItems: fieldItems, labelOf: fieldLabel, onEnter: () => focusNext(field.input)
  });
  const party = createCombo(q("party"), {
    getItems: () => partyItems(field.getValue().id), labelOf: partyLabel, allowNew: true,
    onChange(v) {
      const p = v.id && state.partiesById[v.id];
      if (!p) return;
      // 取引先の履歴から、空いている欄だけ自動で入れる
      const last = p.last || {};
      const fid = (p.fieldIds && p.fieldIds[0]) || last.fieldId;
      if (field.isEmpty() && fid && state.fieldsById[fid]) field.setValue(fid);
      if (debit.isEmpty() && last.debitId && state.accountsById[last.debitId]) debit.setValue(last.debitId);
      if (credit.isEmpty() && last.creditId && state.accountsById[last.creditId]) credit.setValue(last.creditId);
      if (!taxTouched && last.tax != null) taxEl.value = String(last.tax);
      else defaultTax();
    },
    onEnter: () => focusNext(party.input)
  });

  taxEl.addEventListener("change", () => { taxTouched = true; });
  dateEl.addEventListener("change", updateSeq);
  dateEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); focusNext(dateEl); } });
  taxEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); focusNext(taxEl); } });
  markEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
  [memoEl, amountEl].forEach((el) => el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (el === memoEl) focusNext(el); else save();
    }
  }));

  function setInitial() {
    if (isEdit) {
      const dl = voucher.lines.find((l) => l.side === "debit");
      const cl = voucher.lines.find((l) => l.side === "credit");
      dateEl.value = voucher.date;
      debit.setValue(dl.accId);
      credit.setValue(cl.accId);
      field.setValue(voucher.fieldId);
      if (voucher.partyId && state.partiesById[voucher.partyId]) party.setValue(voucher.partyId);
      memoEl.value = voucher.lines.map((l) => l.memo).find((m) => m) || "";
      amountEl.value = String(dl.amount);
      taxEl.value = String(dl.tax || 0);
      taxTouched = true;
      markEl.value = voucher.mark || "";
    } else {
      dateEl.value = defaultDate();
      taxEl.value = "0";
    }
    updateSeq();
  }

  function resetForNext() {
    debit.clear(); credit.clear(); field.clear(); party.clear();
    memoEl.value = ""; amountEl.value = ""; markEl.value = "";
    taxEl.value = "0"; taxTouched = false;
    dateEl.value = defaultDate();
    updateSeq();
    party.focus();
  }

  async function save() {
    msg("");
    const date = dateEl.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return msg("日付を入れてください。");
    const d = debit.getValue().id;
    const c = credit.getValue().id;
    if (!d) return msg("借方の科目を選んでください。");
    if (!c) return msg("貸方の科目を選んでください。");
    if (d === c) return msg("借方と貸方に同じ科目は使えません。");
    const amount = parseAmount(amountEl.value);
    if (!(amount > 0)) return msg("金額は1円以上の数字で入れてください。");
    const tax = parseInt(taxEl.value, 10);
    const memo = memoEl.value.trim();
    const pv = party.getValue();
    const fv = field.getValue().id || "";
    saveBtn.disabled = true;
    try {
      let partyId = pv.id || "";
      if (!partyId && pv.newName) {
        partyId = "pty_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        await setDoc(doc(col("parties"), partyId), {
          name: pv.newName, kana: "", fieldIds: fv ? [fv] : [], spot: false, hidden: false, count: 0,
          createdAt: serverTimestamp()
        });
      }
      const month = monthOf(date);
      let seq, entryDate;
      if (isEdit && voucher.month === month) {
        seq = voucher.seq;
        entryDate = voucher.entryDate;
      } else {
        const list = month === state.month ? state.vouchers : await fetchMonthVouchers(month);
        seq = maxSeq(list) + 1;
        entryDate = isEdit ? voucher.entryDate : ymd(new Date());
      }
      const da = state.accountsById[d], ca = state.accountsById[c];
      const pl = [da, ca].find((a) => a.kind === "expense" || a.kind === "revenue");
      const biz = pl ? pl.biz || "life" : "life";
      const data = {
        month, seq, date, entryDate, late: entryDate > date,
        fieldId: fv, partyId, mark: markEl.value,
        lines: [
          { side: "debit", accId: d, amount, tax, memo, tags: [], biz },
          { side: "credit", accId: c, amount, tax, memo: "", tags: [], biz }
        ],
        updatedAt: serverTimestamp()
      };
      let id;
      if (isEdit) id = voucher.id;
      else { id = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); data.createdAt = serverTimestamp(); }
      await setDoc(doc(col("vouchers"), id), data, { merge: true });
      if (partyId) {
        const upd = { last: { debitId: d, creditId: c, tax, fieldId: fv }, lastUsed: date };
        if (!isEdit) upd.count = increment(1);
        if (fv) upd.fieldIds = arrayUnion(fv);
        await updateDoc(doc(col("parties"), partyId), upd);
        await loadParties();
      }
      state.lastDate = date;
      if (monthOf(date) !== state.month && !isEdit) {
        // 別の月度に記帳したときは、その月度を表示する
        state.month = monthOf(date);
      }
      await loadVouchers();
      if (isEdit) { if (onSaved) onSaved(); }
      else {
        resetForNext();
        msg(`登録しました（${month}-${seq}）`);
        if (onSaved) onSaved();
      }
    } catch (err) {
      msg("保存に失敗しました：" + (err.code || err.message));
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", save);
  if (isEdit) {
    q("cancel").addEventListener("click", () => onCancel && onCancel());
    const del = q("delete");
    let armed = null;
    del.addEventListener("click", async () => {
      if (!armed) {
        del.textContent = "もう一度押すと削除します";
        armed = setTimeout(() => { del.textContent = "削除"; armed = null; }, 4000);
        return;
      }
      clearTimeout(armed);
      del.disabled = true;
      try {
        await deleteDoc(doc(col("vouchers"), voucher.id));
        await loadVouchers();
        if (onDeleted) onDeleted();
      } catch (err) {
        del.disabled = false;
        msg("削除に失敗しました：" + (err.code || err.message));
      }
    });
  }
  setInitial();
  return { focusFirst: () => party.focus() };
}

// ---------- 画面 ----------
export function renderEntry() {
  const v = $("view");
  if (state.accounts.length === 0) {
    v.innerHTML = `<div class="placeholder">先に「設定」で、科目と分野の初期データを入れてください。</div>`;
    return;
  }
  v.innerHTML = `
    <div class="monthbar">
      <button type="button" class="navbtn" id="m-prev" aria-label="前の月度">◀</button>
      <h2 id="m-title"></h2>
      <button type="button" class="navbtn" id="m-next" aria-label="次の月度">▶</button>
    </div>
    <section class="panel">
      <h3><span class="bar"></span>新しい仕訳</h3>
      <div id="entry-form"></div>
    </section>
    <section class="panel nopad">
      <div class="panel-head">
        <h3><span class="bar"></span><span id="list-title"></span></h3>
        <label class="note" for="list-q">絞り込み</label>
        <input type="search" id="list-q" placeholder="取引先・摘要・金額・科目">
      </div>
      <div class="tablewrap">
        <table class="tbl">
          <thead><tr>
            <th>伝番</th><th>税率</th><th>借方</th><th>貸方</th><th>分野</th><th>取引先</th><th>摘要</th><th class="amt">金額</th><th>印</th>
          </tr></thead>
          <tbody id="vbody"></tbody>
        </table>
      </div>
      <div class="totals" id="totals"></div>
    </section>`;
  $("m-prev").addEventListener("click", () => changeMonth(-1));
  $("m-next").addEventListener("click", () => changeMonth(1));
  $("list-q").addEventListener("input", drawList);
  $("vbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-vid]");
    if (!tr) return;
    const vo = state.vouchers.find((x) => x.id === tr.dataset.vid);
    if (vo) openEdit(vo);
  });
  mountVoucherForm($("entry-form"), { onSaved: drawList });
  drawList();
}

async function changeMonth(delta) {
  state.month = shiftMonth(state.month, delta);
  state.lastDate = null;
  try {
    await loadVouchers();
  } catch (err) {
    $("error").textContent = "仕訳の読み込みに失敗しました：" + err.code;
    $("error").hidden = false;
  }
  renderEntry();
}

function openEdit(vo) {
  if (!isSimple(vo)) {
    $("error").textContent = "複合仕訳の修正は、次のバージョン（D-2）で対応します。";
    $("error").hidden = false;
    return;
  }
  $("error").hidden = true;
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
    <h2>仕訳を修正（${esc(vo.month)}-${esc(vo.seq)}）</h2><div id="edit-form"></div></div>`);
  mountVoucherForm($("edit-form"), {
    voucher: vo,
    onSaved: () => { closeModal(); renderEntry(); },
    onCancel: closeModal,
    onDeleted: () => { closeModal(); renderEntry(); }
  });
}

function fmtMD(dateStr) {
  return `${parseInt(dateStr.slice(5, 7), 10)}/${parseInt(dateStr.slice(8, 10), 10)}`;
}

function voucherText(vo) {
  const parts = [];
  vo.lines.forEach((l) => {
    const a = state.accountsById[l.accId];
    parts.push(a ? a.name : "", l.memo, String(l.amount));
  });
  parts.push(partyLabel(vo.partyId), fieldLabel(vo.fieldId));
  return norm(parts.join(" "));
}

function voucherRows(vo, alt) {
  const debits = vo.lines.filter((l) => l.side === "debit");
  const credits = vo.lines.filter((l) => l.side === "credit");
  const n = Math.max(debits.length, credits.length);
  const multi = debits.length > 1 || credits.length > 1;
  const total = debits.reduce((s, l) => s + l.amount, 0);
  const firstLine = vo.lines[0] || {};
  const memo = vo.lines.map((l) => l.memo).find((m) => m) || "";
  const isRev = credits.some((l) => (state.accountsById[l.accId] || {}).kind === "revenue");
  const cls = (multi ? "cmp " : "") + (alt ? "alt" : "");
  const chipOf = (l) => {
    const a = l && state.accountsById[l.accId];
    return a ? accChip(a) + (multi ? ` <span class="num muted">${yen(l.amount)}</span>` : "") : "";
  };
  const fd = state.fieldsById[vo.fieldId];
  let html = "";
  for (let i = 0; i < n; i++) {
    const first = i === 0;
    html += `<tr data-vid="${esc(vo.id)}" class="${cls}">
      <td class="num muted ${multi && first ? "first" : ""}">${first ? esc(vo.month + "-" + vo.seq) : ""}</td>
      <td>${first ? (firstLine.tax ? esc(firstLine.tax) + "%" : "ー") : ""}</td>
      <td>${chipOf(debits[i])}</td>
      <td>${chipOf(credits[i])}</td>
      <td>${first && fd ? `<span class="fd"><b>${esc(fd.no)}</b>${esc(hk(fd.name))}</span>` : ""}</td>
      <td>${first ? esc(hk(partyLabel(vo.partyId))) : ""}</td>
      <td>${first ? esc(hk(memo)) : ""}${first && vo.late ? ` <span class="chip late">後日記帳 ${esc(fmtMD(vo.entryDate))}</span>` : ""}${first && firstLine.biz === "biz" ? ' <span class="chip biz">事業</span>' : ""}</td>
      <td class="amt num ${isRev ? "inc" : ""}">${first ? (isRev ? "+" : "") + yen(total) : ""}</td>
      <td class="mk">${first ? esc(vo.mark || "") : ""}</td>
    </tr>`;
  }
  return html;
}

function drawList() {
  const titleEl = $("list-title");
  if (!titleEl) return;
  $("m-title").textContent = `${state.month}月度`;
  const qv = norm($("list-q").value).trim();
  const list = state.vouchers.filter((vo) => !qv || voucherText(vo).includes(qv));
  titleEl.textContent = `${state.month}月度の仕訳  ${list.length}件${qv ? `（全${state.vouchers.length}件）` : ""}`;
  let html = "";
  let curDate = "";
  let altIdx = 0;
  list.forEach((vo) => {
    if (vo.date !== curDate) {
      curDate = vo.date;
      const day = list.filter((x) => x.date === curDate);
      let out = 0, inc = 0;
      day.forEach((x) => x.lines.forEach((l) => {
        const a = state.accountsById[l.accId];
        if (!a) return;
        if (l.side === "debit" && a.kind === "expense") out += l.amount;
        if (l.side === "credit" && a.kind === "revenue") inc += l.amount;
      }));
      const wd = new Date(curDate + "T00:00:00").getDay();
      const wdc = wd === 6 ? "sat" : wd === 0 ? "sun" : "";
      html += `<tr class="day"><td colspan="9"><div class="dh"><span class="d num">${esc(fmtMD(curDate))}</span>
        <span class="wd ${wdc}">${WD[wd]}</span>
        <span class="pill out">支出 <span class="num">¥${yen(out)}</span></span>
        <span class="pill inc">収入 <span class="num">¥${yen(inc)}</span></span>
        <span class="note">${day.length}件</span></div></td></tr>`;
      altIdx = 0;
    }
    html += voucherRows(vo, altIdx % 2 === 1);
    altIdx++;
  });
  if (!list.length) html = `<tr><td colspan="9" class="empty">この月度の仕訳はまだありません。</td></tr>`;
  $("vbody").innerHTML = html;
  let dt = 0, ct = 0;
  state.vouchers.forEach((vo) => vo.lines.forEach((l) => { if (l.side === "debit") dt += l.amount; else ct += l.amount; }));
  $("totals").innerHTML = `<span class="note">この月度の借方合計 ¥${yen(dt)}／貸方合計 ¥${yen(ct)}</span>
    <span class="${dt === ct ? "ok" : "ng"}">${dt === ct ? "一致 ✓" : "不一致 ⚠"}</span>`;
}
