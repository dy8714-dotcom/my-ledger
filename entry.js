// 記帳画面（入力欄と仕訳の一覧）
import { state, col, db, loadParties, loadVouchers, fetchMonthVouchers } from "./state.js?v=0.2I1c";
import { downloadFullBackup } from "./backup.js?v=0.2I1c";
import { $, esc, norm, hk, yen, parseAmount, WD, ymd, monthOf, shiftMonth, firstDayOf, accChip, openModal, closeModal }
  from "./util.js?v=0.2I1c";
import { createCombo } from "./combo.js?v=0.2I1c";
import { doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, increment, arrayUnion, deleteField }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { patternsOf, sortPatterns, describePattern, addPattern, fromTemplate } from "./patterns.js?v=0.2I1c";

// ---------- 候補の作り方 ----------
const isBlank = (a) => a.name.startsWith("（") || a.name === "ー";

function accountItems() {
  return state.accounts.filter((a) => !a.hidden && !isBlank(a)).map((a) => ({
    id: a.id, no: a.no, name: a.name, kana: a.kana || "", count: 0, boost: false, html: accChip(a)
  }));
}

// 学習用：損益の科目（費用・収益）があれば、それだけを数える
function statAccIds(ids) {
  const u = [...new Set((ids || []).filter(Boolean))];
  const pl = u.filter((id) => { const a = state.accountsById[id]; return a && (a.kind === "expense" || a.kind === "revenue"); });
  return pl.length ? pl : u;
}

// 分野：選んだ科目でよく使った順（絞り込みはしない）
function fieldItems(accIds) {
  const ids = statAccIds(accIds);
  const st = state.stats.accField;
  return state.fields.filter((f) => !f.hidden).map((f) => ({
    id: f.id, no: f.no, name: f.name, kana: "", boost: false,
    count: ids.reduce((sum, a) => sum + (st[a + "__" + f.id] || 0), 0),
    html: `<span class="fd"><b>${esc(f.no)}</b>${esc(hk(f.name))}</span>`
  }));
}

// 取引先：選んだ分野でよく使った順。分野が空なら、使用回数の順
function partyItems(fieldId) {
  const st = state.stats.fieldParty;
  return state.parties.filter((p) => !p.hidden).map((p) => {
    const pair = fieldId ? st[fieldId + "__" + p.id] || 0 : 0;
    return {
      id: p.id, no: null, name: p.name, kana: p.kana || "", count: pair * 1000 + (p.count || 0),
      boost: !!(fieldId && ((p.fieldIds || []).includes(fieldId) || pair > 0)),
      spot: !!p.spot,
      html: `<span class="pn">${esc(hk(p.name))}${p.spot ? ' <span class="spot">スポット</span>' : ""}</span><span class="cnt">${p.count || 0}回</span>`
    };
  });
}

// その取引先で、いちばんよく使った分野
function bestFieldOf(p) {
  let best = null, n = 0;
  Object.entries(state.stats.fieldParty).forEach(([k, v]) => {
    const [fid, pid] = k.split("__");
    if (pid === p.id && v > n && state.fieldsById[fid]) { best = fid; n = v; }
  });
  return best || (p.fieldIds || []).find((f) => state.fieldsById[f]) || (p.last && p.last.fieldId) || null;
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
  // 削除済みの伝番も含める（戻したときにぶつからないように、番号は使い回さない）
  return Math.max(list.maxSeqAll || 0, list.reduce((m, v) => Math.max(m, v.seq || 0), 0));
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
// ふだんは「1行入力」。「＋行を追加」（Ctrl+↓）を押すと、複合仕訳の「行ごとの入力」に切り替わる。
function mountVoucherForm(root, { voucher = null, onSaved, onCancel, onDeleted }) {
  const isEdit = !!voucher;
  root.innerHTML = `
    <div class="vgrid">
      <div class="in c2"><label>日付</label><input type="date" data-k="date"></div>
      <div class="in c1"><label>伝番</label><div class="box seq" data-k="seq"></div></div>
      <div class="in c1 simple"><label>税率</label>
        <select data-k="tax"><option value="0">ー</option><option value="8">8%</option><option value="10">10%</option></select></div>
      <div class="in c2 simple"><label>借方</label><div data-k="debit"></div></div>
      <div class="in c2 simple"><label>貸方</label><div data-k="credit"></div></div>
      <div class="in c2"><label>分野</label><div data-k="field"></div></div>
      <div class="in c2"><label>取引先</label><div data-k="party"></div></div>
      <div class="in c7 simple"><label>摘要</label><input type="text" data-k="memo" autocomplete="off"></div>
      <div class="in c2 simple"><label>金額</label><input type="text" inputmode="numeric" data-k="amount" class="amt" autocomplete="off"></div>
      <div class="in c1"><label>印</label>
        <select data-k="mark"><option value="">ー</option><option>☆</option><option>★</option><option>◆</option><option>◇</option></select></div>
    </div>
    <div class="patbar" data-k="patbar" hidden></div>
    <div class="lines" data-k="lines" hidden>
      <div class="lhead"><span>区分</span><span>科目</span><span class="r">金額</span><span>税率</span><span>摘要</span><span></span></div>
      <div data-k="linerows"></div>
      <div class="lfoot" data-k="balance"></div>
    </div>
    <div class="vactions">
      <button type="button" class="primary" data-k="save">${isEdit ? "保存" : "登録"}</button>
      <label class="remember" data-k="rememberwrap" hidden><input type="checkbox" data-k="remember"> <span data-k="rememberlabel"></span></label>
      <button type="button" class="sub" data-k="addline">＋ 行を追加</button>
      ${isEdit ? "" : '<button type="button" class="sub" data-k="preview">プレビュー</button>'}
      ${isEdit ? '<button type="button" class="sub" data-k="cancel">キャンセル</button>' : ""}
      ${isEdit ? '<button type="button" class="danger" data-k="delete">削除</button>' : ""}
      <span class="vmsg" data-k="msg"></span>
      <span class="note hint">${isEdit ? "" : "Enter：次の欄へ（金額でEnter：登録）　Ctrl＋↓：行を追加（複合仕訳）"}</span>
    </div>`;
  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  const dateEl = q("date"), seqEl = q("seq"), taxEl = q("tax"), memoEl = q("memo");
  const amountEl = q("amount"), markEl = q("mark"), msgEl = q("msg"), saveBtn = q("save");
  const simpleEls = root.querySelectorAll(".simple");
  const patbar = q("patbar"), rememberEl = q("remember"), rememberWrap = q("rememberwrap"), rememberLabel = q("rememberlabel");
  const linesBox = q("lines"), rowsHost = q("linerows"), balanceEl = q("balance");
  let taxTouched = false;
  let detail = false;
  const rows = [];

  const msg = (m) => { msgEl.textContent = m || ""; };

  function updateSeq() {
    const m = monthOf(dateEl.value || ymd(new Date()));
    if (isEdit) seqEl.textContent = `${voucher.month}-${voucher.seq}`;
    else if (m === state.month) seqEl.textContent = `${m}-${maxSeq(state.vouchers) + 1}`;
    else seqEl.textContent = `${m}-自動`;
  }

  function accTax(accId) {
    const a = state.accountsById[accId];
    return String((a && a.tax) || 0);
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
    getItems: () => fieldItems(currentAccIds()), labelOf: fieldLabel, onEnter: () => focusNext(field.input)
  });
  const party = createCombo(q("party"), {
    getItems: () => partyItems(field.getValue().id), labelOf: partyLabel, allowNew: true,
    onChange(v) {
      refreshParty(v, true);
      const p = v.id && state.partiesById[v.id];
      if (!p) return;
      // 取引先の履歴から、空いている欄だけ自動で入れる
      const fid = bestFieldOf(p);
      if (field.isEmpty() && fid) field.setValue(fid);
      const best = sortPatterns(patternsOf(p))[0];
      if (best) applyPattern(best, false);
    },
    onEnter: () => { if (detail && rows.length) lineFocus(rows[0], "amount"); else focusNext(party.input); }
  });

  function currentAccIds() {
    return detail ? rows.map((r) => r.acc.getValue().id) : [debit.getValue().id, credit.getValue().id];
  }

  // 取引先まわりの表示：パターンの候補ボタンと、「覚える」のチェック
  function refreshParty(v, resetCheck) {
    const val = v || party.getValue();
    const p = val.id && state.partiesById[val.id];
    const name = p ? hk(p.name) : val.newName || "";
    rememberWrap.hidden = !name;
    rememberLabel.textContent = name ? `この形を、取引先「${name}」の入力パターンとして覚える` : "";
    if (resetCheck) rememberEl.checked = !isEdit;
    const list = p ? sortPatterns(patternsOf(p)) : [];
    patbar.hidden = list.length === 0;
    patbar.innerHTML = list.length
      ? `<span class="note">この取引先のパターン（押すと入れ替わります）：</span>` +
        list.map((pt, i) => `<button type="button" class="pat" data-i="${i}">${esc(describePattern(pt))}<span class="n">${pt.uses || 0}回</span></button>`).join("")
      : "";
    patbar._list = list;
  }
  patbar.addEventListener("click", (e) => {
    const b = e.target.closest(".pat");
    if (!b || !patbar._list) return;
    applyPattern(patbar._list[parseInt(b.dataset.i, 10)], true);
    if (detail && rows.length) lineFocus(rows[0], "amount"); else amountEl.focus();
  });

  // パターンを入力欄に入れる。force=false のときは、まだ何も入れていない場合だけ
  function applyPattern(pat, force) {
    if (!pat || !pat.lines || pat.lines.length < 2) return;
    const empty = debit.isEmpty() && credit.isEmpty() && !detail;
    if (!force && !empty) return;
    if (force) { if (detail) leaveDetail(); debit.clear(); credit.clear(); taxTouched = false; }
    const ds = pat.lines.filter((l) => l.side === "debit");
    const cs = pat.lines.filter((l) => l.side === "credit");
    const known = pat.lines.every((l) => state.accountsById[l.accId]);
    if (!known) return;
    if (ds.length === 1 && cs.length === 1) {
      debit.setValue(ds[0].accId);
      credit.setValue(cs[0].accId);
      if (!taxTouched) taxEl.value = String(ds[0].tax || 0);
      const tpl = ds[0].memo || cs[0].memo || "";
      if (tpl && (force || !memoEl.value.trim())) { memoEl.value = fromTemplate(tpl, dateEl.value); autoMemo = { tpl, text: memoEl.value }; }
    } else {
      enterDetail(pat.lines.map((l) => ({ ...l, memo: fromTemplate(l.memo, dateEl.value) })));
      [...ds, ...cs].forEach((l, i) => { if (l.memo && rows[i]) rows[i].auto = { tpl: l.memo, text: rows[i].memoEl.value }; });
    }
  }

  // 日付を変えたら、自動で入れた摘要の日付も合わせる（手で直した摘要はそのまま）
  let autoMemo = null;
  function refreshAutoMemos() {
    if (autoMemo && memoEl.value === autoMemo.text) {
      memoEl.value = fromTemplate(autoMemo.tpl, dateEl.value);
      autoMemo.text = memoEl.value;
    }
    rows.forEach((r) => {
      if (r.auto && r.memoEl.value === r.auto.text) {
        r.memoEl.value = fromTemplate(r.auto.tpl, dateEl.value);
        r.auto.text = r.memoEl.value;
      }
    });
  }

  // ----- 複合仕訳：行ごとの入力 -----
  const sumOf = (side) => rows.reduce((s, r) => {
    if (r.sideEl.value !== side) return s;
    const n = parseAmount(r.amountEl.value);
    return s + (n > 0 ? n : 0);
  }, 0);

  function updateBalance() {
    const d = sumOf("debit"), c = sumOf("credit"), diff = d - c;
    balanceEl.innerHTML = `<span>借方計 <b class="num">¥${yen(d)}</b></span><span>貸方計 <b class="num">¥${yen(c)}</b></span>
      <span class="${diff === 0 && d > 0 ? "ok" : "ng"}">${diff === 0 && d > 0 ? "差額 ¥0 ✓" : `差額 ¥${yen(Math.abs(diff))}（${diff > 0 ? "貸方が不足" : diff < 0 ? "借方が不足" : "金額を入れてください"}）`}</span>`;
  }

  function lineFocus(r, what) {
    ({ side: r.sideEl, acc: r.acc.input, amount: r.amountEl, tax: r.taxEl, memo: r.memoEl })[what].focus();
  }

  function addRow(init = {}) {
    const el = document.createElement("div");
    el.className = "lrow";
    el.innerHTML = `
      <select data-r="side"><option value="debit">借方</option><option value="credit">貸方</option></select>
      <div data-r="acc"></div>
      <input type="text" inputmode="numeric" data-r="amount" class="amt" autocomplete="off">
      <select data-r="tax"><option value="0">ー</option><option value="8">8%</option><option value="10">10%</option></select>
      <input type="text" data-r="memo" autocomplete="off">
      <button type="button" class="x" aria-label="この行を削除">×</button>`;
    rowsHost.appendChild(el);
    const g = (k) => el.querySelector(`[data-r="${k}"]`);
    const r = { el, sideEl: g("side"), amountEl: g("amount"), taxEl: g("tax"), memoEl: g("memo"), taxTouched: !!init.taxSet };
    r.acc = createCombo(g("acc"), {
      getItems: accountItems, labelOf: accLabel,
      onChange(v) { if (!r.taxTouched) r.taxEl.value = accTax(v.id); },
      onEnter: () => lineFocus(r, "amount")
    });
    r.sideEl.value = init.side || "debit";
    if (init.accId) r.acc.setValue(init.accId);
    r.amountEl.value = init.amount || "";
    r.taxEl.value = String(init.tax != null ? init.tax : 0);
    r.memoEl.value = init.memo || "";
    r.taxEl.addEventListener("change", () => { r.taxTouched = true; });
    r.sideEl.addEventListener("change", updateBalance);
    r.amountEl.addEventListener("input", updateBalance);
    r.sideEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lineFocus(r, "acc"); } });
    r.amountEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lineFocus(r, "memo"); } });
    r.taxEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lineFocus(r, "memo"); } });
    r.memoEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const i = rows.indexOf(r);
      if (i < rows.length - 1) lineFocus(rows[i + 1], "acc");
      else if (sumOf("debit") > 0 && sumOf("debit") === sumOf("credit")) save();
      else addLine();
    });
    el.querySelector(".x").addEventListener("click", () => {
      if (rows.length <= 2) { msg("複合仕訳には、最低でも借方1行と貸方1行が必要です。"); return; }
      rows.splice(rows.indexOf(r), 1);
      el.remove();
      updateBalance();
    });
    rows.push(r);
    updateBalance();
    return r;
  }

  function enterDetail(fromLines) {
    if (detail) return;
    detail = true;
    simpleEls.forEach((e) => { e.hidden = true; });
    linesBox.hidden = false;
    if (fromLines) {
      const ds = fromLines.filter((l) => l.side === "debit");
      const cs = fromLines.filter((l) => l.side === "credit");
      [...ds, ...cs].forEach((l) => addRow({ side: l.side, accId: l.accId, amount: l.amount ? String(l.amount) : "", tax: l.tax, memo: l.memo, taxSet: true }));
    } else {
      const amt = amountEl.value;
      addRow({ side: "debit", accId: debit.getValue().id, amount: amt, tax: taxEl.value, memo: memoEl.value.trim(), taxSet: true });
      addRow({ side: "credit", accId: credit.getValue().id, amount: amt, tax: taxEl.value, taxSet: true });
    }
    q("addline").textContent = "＋ 行を追加";
  }

  function leaveDetail() {
    detail = false;
    rows.length = 0;
    rowsHost.innerHTML = "";
    linesBox.hidden = true;
    simpleEls.forEach((e) => { e.hidden = false; });
  }

  function addLine() {
    if (!detail) {
      const filled = !debit.isEmpty() && !credit.isEmpty();
      enterDetail();
      const extra = filled ? addExtra() : null;
      const empty = rows.find((x) => !x.acc.getValue().id);
      lineFocus(empty || extra || rows[0], "acc");
      return;
    }
    const r = addExtra();
    lineFocus(r, "acc");
  }

  function addExtra() {
    const d = sumOf("debit"), c = sumOf("credit");
    const side = d <= c ? "debit" : "credit";
    const diff = Math.abs(d - c);
    return addRow({ side, amount: diff > 0 ? String(diff) : "" });
  }

  q("addline").addEventListener("click", addLine);
  if (!isEdit) q("preview").addEventListener("click", preview);
  root.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "ArrowDown") { e.preventDefault(); addLine(); }
  });

  taxEl.addEventListener("change", () => { taxTouched = true; });
  dateEl.addEventListener("change", () => { updateSeq(); refreshAutoMemos(); });
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
      dateEl.value = voucher.date;
      field.setValue(voucher.fieldId);
      if (voucher.partyId && state.partiesById[voucher.partyId]) party.setValue(voucher.partyId);
      markEl.value = voucher.mark || "";
      if (isSimple(voucher)) {
        const dl = voucher.lines.find((l) => l.side === "debit");
        const cl = voucher.lines.find((l) => l.side === "credit");
        debit.setValue(dl.accId);
        credit.setValue(cl.accId);
        memoEl.value = voucher.lines.map((l) => l.memo).find((m) => m) || "";
        amountEl.value = String(dl.amount);
        taxEl.value = String(dl.tax || 0);
        taxTouched = true;
      } else {
        enterDetail(voucher.lines);
      }
    } else {
      dateEl.value = defaultDate();
      taxEl.value = "0";
    }
    updateSeq();
    refreshParty(party.getValue(), true);
  }

  function resetForNext() {
    leaveDetail();
    autoMemo = null;
    debit.clear(); credit.clear(); field.clear(); party.clear();
    memoEl.value = ""; amountEl.value = ""; markEl.value = "";
    taxEl.value = "0"; taxTouched = false;
    dateEl.value = defaultDate();
    updateSeq();
    refreshParty(party.getValue(), true);
    party.focus();
  }

  // 入力から、仕訳の行（lines）を作る。問題があれば error を返す
  function buildLines() {
    if (!detail) {
      const d = debit.getValue().id;
      const c = credit.getValue().id;
      if (!d) return { error: "借方の科目を選んでください。" };
      if (!c) return { error: "貸方の科目を選んでください。" };
      if (d === c) return { error: "借方と貸方に同じ科目は使えません。" };
      const amount = parseAmount(amountEl.value);
      if (!(amount > 0)) return { error: "金額は1円以上の数字で入れてください。" };
      const tax = parseInt(taxEl.value, 10);
      const memo = memoEl.value.trim();
      return { lines: [
        { side: "debit", accId: d, amount, tax, memo, tags: [], biz: "life" },
        { side: "credit", accId: c, amount, tax, memo: "", tags: [], biz: "life" }
      ] };
    }
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const accId = r.acc.getValue().id;
      const amount = parseAmount(r.amountEl.value);
      if (!accId) return { error: `${i + 1}行目の科目を選んでください。` };
      if (!(amount > 0)) return { error: `${i + 1}行目の金額は、1円以上の数字で入れてください。` };
      lines.push({ side: r.sideEl.value, accId, amount, tax: parseInt(r.taxEl.value, 10), memo: r.memoEl.value.trim(), tags: [], biz: "life" });
    }
    const dsum = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
    const csum = lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
    if (!lines.some((l) => l.side === "debit") || !lines.some((l) => l.side === "credit")) {
      return { error: "借方と貸方を、それぞれ1行以上入れてください。" };
    }
    if (dsum !== csum) return { error: `借方計と貸方計が一致しません（差額 ¥${yen(Math.abs(dsum - csum))}）。` };
    return { lines };
  }

  function applyBiz(lines) {
    const isPL = (a) => a && (a.kind === "expense" || a.kind === "revenue");
    const plFirst = lines.map((l) => state.accountsById[l.accId]).find(isPL);
    lines.forEach((l) => {
      const a = state.accountsById[l.accId];
      l.biz = isPL(a) ? a.biz || "life" : plFirst ? plFirst.biz || "life" : "life";
    });
  }

  // プレビュー：登録するとこう見える、を一覧と同じ形で見せる
  function preview() {
    msg("");
    const date = dateEl.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return msg("日付を入れてください。");
    const built = buildLines();
    if (built.error) return msg(built.error);
    const lines = built.lines;
    applyBiz(lines);
    const pv = party.getValue();
    const month = monthOf(date);
    const seq = month === state.month ? maxSeq(state.vouchers) + 1 : "自動";
    const vo = {
      id: "preview", month, seq, date, entryDate: ymd(new Date()), late: ymd(new Date()) > date,
      fieldId: field.getValue().id || "", partyId: pv.id || "", _partyName: pv.newName || "", mark: markEl.value, lines
    };
    const d = lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0);
    const wd = new Date(date + "T00:00:00").getDay();
    openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
      <h2>プレビュー（この内容で登録します）</h2>
      <p class="note">${esc(fmtMD(date))}（${WD[wd]}）　借方計 ¥${yen(d)} ／ 貸方計 ¥${yen(d)} ✓　${pv.newName ? `※取引先「${esc(pv.newName)}」は新規登録されます　` : ""}${!rememberWrap.hidden && rememberEl.checked ? "※この形を入力パターンとして覚えます" : ""}</p>
      <div class="tablewrap"><table class="tbl prev">
        <thead><tr><th>伝番</th><th>税率</th><th>借方</th><th>貸方</th><th>分野</th><th>取引先</th><th>摘要</th><th class="amt">金額</th><th>印</th></tr></thead>
        <tbody>${dayBand(date)}${voucherRows(vo, false)}</tbody></table></div>
      <div class="actions">
        <button type="button" class="sub" id="pv-back">戻って直す</button>
        <button type="button" class="primary" id="pv-ok">この内容で登録</button>
      </div></div>`);
    $("pv-back").addEventListener("click", () => { closeModal(); });
    $("pv-ok").addEventListener("click", () => { closeModal(); save(); });
    $("pv-ok").focus();
  }

  async function save() {
    msg("");
    const date = dateEl.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return msg("日付を入れてください。");
    const built = buildLines();
    if (built.error) return msg(built.error);
    const lines = built.lines;
    // 事業/生活：損益の科目の初期値を、その科目の行に付ける。貸借だけの科目は、伝票内の損益の科目に合わせる
    applyBiz(lines);
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
      const data = {
        month, seq, date, entryDate, late: entryDate > date,
        fieldId: fv, partyId, mark: markEl.value, lines,
        updatedAt: serverTimestamp()
      };
      let id;
      if (isEdit) id = voucher.id;
      else { id = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); data.createdAt = serverTimestamp(); }
      await setDoc(doc(col("vouchers"), id), data, { merge: true });
      const remember = !!(partyId && !rememberWrap.hidden && rememberEl.checked);
      if (partyId) {
        const upd = { lastUsed: date };
        if (!isEdit) upd.count = increment(1);
        if (fv) upd.fieldIds = arrayUnion(fv);
        if (remember) {
          const cur = state.partiesById[partyId];
          upd.patterns = addPattern(cur ? patternsOf(cur) : [], lines, date);
          upd.last = deleteField();
        }
        await updateDoc(doc(col("parties"), partyId), upd);
        await loadParties();
      }
      if (!isEdit && fv) {
        // 学習：この科目でこの分野、この分野でこの取引先、を1回ずつ数える
        const accField = {}, fieldParty = {};
        statAccIds(lines.map((l) => l.accId)).forEach((a) => { accField[a + "__" + fv] = increment(1); });
        if (partyId) fieldParty[fv + "__" + partyId] = increment(1);
        await setDoc(doc(col("meta"), "stats"), { accField, fieldParty }, { merge: true });
        Object.keys(accField).forEach((k) => { state.stats.accField[k] = (state.stats.accField[k] || 0) + 1; });
        Object.keys(fieldParty).forEach((k) => { state.stats.fieldParty[k] = (state.stats.fieldParty[k] || 0) + 1; });
      }
      state.lastDate = date;
      if (monthOf(date) !== state.month && !isEdit) state.month = monthOf(date); // 別の月度に記帳したら、その月度を表示する
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
        await updateDoc(doc(col("vouchers"), voucher.id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() }); // 完全には消さず「削除済み」にする（30日間は設定から戻せる）
        await loadVouchers();
        if (onDeleted) onDeleted();
      } catch (err) {
        del.disabled = false;
        msg("削除に失敗しました：" + (err.code || err.message));
      }
    });
  }
  setInitial();
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
      <div id="selbar" class="selbar" hidden></div>
      <div class="panel-head">
        <h3><span class="bar"></span><span id="list-title"></span></h3>
        <label class="note" for="list-q">絞り込み</label>
        <input type="search" id="list-q" placeholder="取引先・摘要・金額・科目">
      </div>
      <div class="tablewrap">
        <table class="tbl">
          <thead><tr>
            <th class="chk"><input type="checkbox" id="sel-all" aria-label="表示中の仕訳をすべて選ぶ" title="表示中をすべて選ぶ／外す"></th><th>伝番</th><th>税率</th><th>借方</th><th>貸方</th><th>分野</th><th>取引先</th><th>摘要</th><th class="amt">金額</th><th>印</th>
          </tr></thead>
          <tbody id="vbody"></tbody>
        </table>
      </div>
      <div class="totals" id="totals"></div>
    </section>`;
  $("m-prev").addEventListener("click", () => changeMonth(-1));
  $("m-next").addEventListener("click", () => changeMonth(1));
  $("list-q").addEventListener("input", drawList);
  $("sel-all").addEventListener("change", (e) => {
    if (e.target.checked) curList.forEach((vo) => sel.add(vo.id)); else curList.forEach((vo) => sel.delete(vo.id));
    drawList();
  });
  $("vbody").addEventListener("click", (e) => {
    const cell = e.target.closest("td.chk");
    if (cell) {
      const id = cell.parentElement.dataset.vid;
      const input = cell.querySelector("input");
      if (!input) return;
      if (e.target !== input) input.checked = !input.checked;
      toggleSel(id, input.checked, e.shiftKey);
      return;
    }
    const tr = e.target.closest("tr[data-vid]");
    if (!tr) return;
    const vo = state.vouchers.find((x) => x.id === tr.dataset.vid);
    if (vo) openEdit(vo);
  });
  mountVoucherForm($("entry-form"), { onSaved: drawList });
  drawList();
}

async function changeMonth(delta) {
  sel.clear(); lastSelId = null; // 月をまたいだ選択はしない
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

export function openEdit(vo, after, seq) {
  const done = after || renderEntry;
  $("error").hidden = true;
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
    <h2>仕訳を修正（${esc(vo.month)}-${esc(vo.seq)}）</h2>
    ${seq ? `<div class="seqbar"><strong>${seq.i}／${seq.n}件目</strong>
      <button type="button" class="sub" id="seq-skip">この仕訳は直さず次へ</button>
      <button type="button" class="sub" id="seq-stop">ここで終了</button></div>` : ""}
    <div id="edit-form"></div></div>`);
  if (seq) {
    $("seq-skip").addEventListener("click", () => { closeModal(); seq.onSkip(); });
    $("seq-stop").addEventListener("click", () => { closeModal(); seq.onStop(); });
  }
  mountVoucherForm($("edit-form"), {
    voucher: vo,
    onSaved: () => { closeModal(); done(); },
    onCancel: () => { closeModal(); if (seq) seq.onStop(); },
    onDeleted: () => { closeModal(); done(); }
  });
}

// ---------- 選んだ仕訳の一括操作（手順I1b） ----------
const sel = new Set();      // 選んだ仕訳のid（表示中の月度だけ）
let lastSelId = null;       // Shift+クリックの範囲選択の起点
let curList = [];           // いま表示している（絞り込み後の）仕訳

function toggleSel(id, on, shift) {
  if (shift && lastSelId && lastSelId !== id) {
    const a = curList.findIndex((x) => x.id === lastSelId), b = curList.findIndex((x) => x.id === id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) { if (on) sel.add(curList[i].id); else sel.delete(curList[i].id); }
    }
  } else if (on) sel.add(id); else sel.delete(id);
  lastSelId = id;
  drawList();
}

function selectedVouchers() {
  return state.vouchers.filter((vo) => sel.has(vo.id));
}

function drawSelBar() {
  const bar = $("selbar");
  if (!bar) return;
  const vs = selectedVouchers();
  const all = $("sel-all");
  if (all) {
    const n = curList.filter((vo) => sel.has(vo.id)).length;
    all.checked = curList.length > 0 && n === curList.length;
    all.indeterminate = n > 0 && n < curList.length;
  }
  if (!vs.length) { bar.hidden = true; bar.innerHTML = ""; return; }
  const total = vs.reduce((s, vo) => s + vo.lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0), 0);
  bar.hidden = false;
  bar.innerHTML = `<span><strong>${vs.length}件</strong>を選択中（借方計 ¥${yen(total)}）</span>
    <button type="button" class="sub" id="sel-prev">選んだ分をプレビュー</button>
    <button type="button" class="sub" id="sel-edit">順に修正</button>
    <button type="button" class="danger" id="sel-del">まとめて削除</button>
    <button type="button" class="sub" id="sel-clear">選択を解除</button>`;
  $("sel-clear").addEventListener("click", () => { sel.clear(); lastSelId = null; drawList(); });
  $("sel-prev").addEventListener("click", previewSelected);
  $("sel-edit").addEventListener("click", editSelected);
  $("sel-del").addEventListener("click", deleteSelected);
}

function previewSelected() {
  const vs = selectedVouchers();
  if (!vs.length) return;
  const d = vs.reduce((s, vo) => s + vo.lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0), 0);
  const c = vs.reduce((s, vo) => s + vo.lines.filter((l) => l.side === "credit").reduce((x, l) => x + l.amount, 0), 0);
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
    <h2>選んだ仕訳のプレビュー（${vs.length}件）</h2>
    <p class="note">借方計 ¥${yen(d)} ／ 貸方計 ¥${yen(c)} ${d === c ? "一致 ✓" : "不一致 ⚠"}</p>
    <div class="tablewrap"><table class="tbl prev">
      <thead><tr><th>伝番</th><th>税率</th><th>借方</th><th>貸方</th><th>分野</th><th>取引先</th><th>摘要</th><th class="amt">金額</th><th>印</th></tr></thead>
      <tbody>${vs.map((vo, i) => (i === 0 || vs[i - 1].date !== vo.date ? dayBand(vo.date) : "") + voucherRows(vo, i % 2 === 1)).join("")}</tbody></table></div>
    <div class="actions"><button type="button" class="primary" id="pv-close">閉じる</button></div></div>`);
  $("pv-close").addEventListener("click", closeModal);
  $("pv-close").focus();
}

function editSelected() {
  const ids = selectedVouchers().map((vo) => vo.id);
  if (!ids.length) return;
  const n = ids.length;
  const finish = () => { sel.clear(); lastSelId = null; renderEntry(); };
  const step = (k) => {
    while (k < n && !state.vouchers.find((x) => x.id === ids[k])) k++; // 月度が変わるなどで見えなくなった分は飛ばす
    if (k >= n) return finish();
    const vo = state.vouchers.find((x) => x.id === ids[k]);
    openEdit(vo, () => step(k + 1), { i: k + 1, n, onSkip: () => step(k + 1), onStop: finish });
  };
  step(0);
}

function deleteSelected() {
  const vs = selectedVouchers();
  if (!vs.length) return;
  const list = vs.slice(0, 12).map((vo) => {
    const t = vo.lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0);
    return `<li>${esc(vo.month + "-" + vo.seq)}　${esc(fmtMD(vo.date))}　${esc(hk(partyLabel(vo.partyId)))}　¥${yen(t)}</li>`;
  }).join("");
  openModal(`<div class="dialog" role="dialog" aria-modal="true">
    <h2>${vs.length}件の仕訳を削除します</h2>
    <ul class="dellist">${list}${vs.length > 12 ? `<li>…ほか${vs.length - 12}件</li>` : ""}</ul>
    <p class="note">削除の直前に、全データのバックアップ（JSONファイル）が自動でダウンロードされます。削除した仕訳は30日間、「設定」→「削除した仕訳」から元に戻せます。</p>
    <p id="dl-msg" class="note"></p>
    <div class="actions">
      <button type="button" class="sub" id="dl-cancel">やめる</button>
      <button type="button" class="danger" id="dl-ok">バックアップして削除する</button>
    </div></div>`);
  $("dl-cancel").addEventListener("click", closeModal);
  $("dl-ok").addEventListener("click", async () => {
    $("dl-ok").disabled = true; $("dl-cancel").disabled = true;
    const m = $("dl-msg");
    try {
      m.textContent = "バックアップを保存しています…";
      await downloadFullBackup("my-ledger-backup-一括削除前");
      const ids = vs.map((vo) => vo.id);
      for (let i = 0; i < ids.length; i += 400) {
        m.textContent = `削除しています… ${Math.min(i + 400, ids.length)}／${ids.length}`;
        const batch = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => batch.update(doc(col("vouchers"), id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() }));
        await batch.commit();
      }
      await loadVouchers();
      sel.clear(); lastSelId = null;
      closeModal();
      renderEntry();
    } catch (err) {
      console.error("[一括削除]", err);
      m.textContent = "失敗しました：" + (err.code || err.message) + "（途中まで削除されている可能性があります。一覧を確認してください）";
      $("dl-cancel").disabled = false; $("dl-cancel").textContent = "閉じる";
      loadVouchers().then(drawList).catch(() => {});
    }
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

// プレビュー用の日付の帯（例：11/12（木））
function dayBand(date) {
  const wd = new Date(date + "T00:00:00").getDay();
  const wdc = wd === 6 ? "sat" : wd === 0 ? "sun" : "";
  return `<tr class="day"><td colspan="9"><div class="dh"><span class="d num">${esc(fmtMD(date))}</span> <span class="wd ${wdc}">${WD[wd]}</span></div></td></tr>`;
}

function voucherRows(vo, alt, check) {
  const debits = vo.lines.filter((l) => l.side === "debit");
  const credits = vo.lines.filter((l) => l.side === "credit");
  const n = Math.max(debits.length, credits.length);
  const multi = debits.length > 1 || credits.length > 1;
  const total = debits.reduce((s, l) => s + l.amount, 0);
  const firstLine = vo.lines[0] || {};
  const isRev = credits.some((l) => (state.accountsById[l.accId] || {}).kind === "revenue");
  const cls = (multi ? "cmp " : "") + (alt ? "alt " : "") + (check && sel.has(vo.id) ? "sel" : "");
  const chipOf = (l) => {
    const a = l && state.accountsById[l.accId];
    return a ? accChip(a) + (multi ? ` <span class="num muted">${yen(l.amount)}</span>` : "") : "";
  };
  const fd = state.fieldsById[vo.fieldId];
  let html = "";
  for (let i = 0; i < n; i++) {
    const first = i === 0;
    html += `<tr data-vid="${esc(vo.id)}" class="${cls}">
      ${check ? `<td class="chk">${first ? `<input type="checkbox" aria-label="この仕訳を選ぶ"${sel.has(vo.id) ? " checked" : ""}>` : ""}</td>` : ""}
      <td class="num muted ${multi && first ? "first" : ""}">${first ? esc(vo.month + "-" + vo.seq) : ""}</td>
      <td>${(() => { const l = debits[i] || credits[i] || {}; return multi || first ? (l.tax ? esc(l.tax) + "%" : "ー") : ""; })()}</td>
      <td>${chipOf(debits[i])}</td>
      <td>${chipOf(credits[i])}</td>
      <td>${first && fd ? `<span class="fd"><b>${esc(fd.no)}</b>${esc(hk(fd.name))}</span>` : ""}</td>
      <td>${first ? esc(hk(vo._partyName || partyLabel(vo.partyId))) : ""}</td>
      <td class="memo">${esc(hk([...new Set([debits[i] && debits[i].memo, credits[i] && credits[i].memo].filter(Boolean))].join(" ／ ")))}${first && vo.late ? ` <span class="chip late">後日記帳 ${esc(fmtMD(vo.entryDate))}</span>` : ""}${first && firstLine.biz === "biz" ? ' <span class="chip biz">事業</span>' : ""}</td>
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
  curList = list;
  for (const id of [...sel]) if (!state.vouchers.some((x) => x.id === id)) sel.delete(id);
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
      html += `<tr class="day"><td colspan="10"><div class="dh"><span class="d num">${esc(fmtMD(curDate))}</span>
        <span class="wd ${wdc}">${WD[wd]}</span>
        <span class="pill out">支出 <span class="num">¥${yen(out)}</span></span>
        <span class="pill inc">収入 <span class="num">¥${yen(inc)}</span></span>
        <span class="note">${day.length}件</span></div></td></tr>`;
      altIdx = 0;
    }
    html += voucherRows(vo, altIdx % 2 === 1, true);
    altIdx++;
  });
  if (!list.length) html = `<tr><td colspan="10" class="empty">この月度の仕訳はまだありません。</td></tr>`;
  $("vbody").innerHTML = html;
  drawSelBar();
  let dt = 0, ct = 0;
  state.vouchers.forEach((vo) => vo.lines.forEach((l) => { if (l.side === "debit") dt += l.amount; else ct += l.amount; }));
  $("totals").innerHTML = `<span class="note">この月度の借方合計 ¥${yen(dt)}／貸方合計 ¥${yen(ct)}</span>
    <span class="${dt === ct ? "ok" : "ng"}">${dt === ct ? "一致 ✓" : "不一致 ⚠"}</span>`;
}
