// 元帳・検索（条件で絞り込み、科目を1つ選ぶと残高を積み上げて表示）
import { kindOf, KINDS, kindChip } from "./kinds.js?v=0.2I11d";
import { state, col, loadAllVouchers } from "./state.js?v=0.2I11d";
import { $, esc, norm, hk, yen, parseAmount, WD, accChip, showError } from "./util.js?v=0.2I11d";
import { createCombo } from "./combo.js?v=0.2I11d";
import { openEdit } from "./entry.js?v=0.2I11d";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const isBlank = (a) => a.name.startsWith("（") || a.name === "ー";
const idxOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + (mm - 1); };
const keyOf = (idx) => String(Math.floor(idx / 12)).padStart(2, "0") + "." + ((idx % 12) + 1);
const ymToKey = (v) => keyOf((parseInt(v.slice(0, 4), 10) - 2000) * 12 + parseInt(v.slice(5, 7), 10) - 1);
const keyToYm = (k) => { const i = idxOf(k); return `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; };
const todayKey = () => { const d = new Date(); return String(d.getFullYear()).slice(2) + "." + (d.getMonth() + 1); };
const isBS = (a) => a && (a.kind === "asset" || a.kind === "liability" || a.kind === "equity");
const MARKS = [["☆", "☆"], ["★", "★"], ["◇", "◇"], ["◆", "◆"], ["late", "後日記帳"], ["multi", "複合仕訳"]];

export const defaultCond = () => ({
  accounts: [], side: "both", period: "month", fromM: todayKey(), toM: todayKey(), dateFrom: "", dateTo: "",
  min: "", max: "", fields: [], parties: [], memo: "", biz: [], tax: [], marks: [], kinds: []
});

// ---------- 絞り込みの計算（画面なしで試験できるように分けてある） ----------
function rangeOf(c) {
  if (c.period === "all") return { lo: -Infinity, hi: Infinity, dFrom: "", dTo: "" };
  if (c.period === "year") { const t = idxOf(todayKey()); const s = t - (t % 12); return { lo: s, hi: s + 11, dFrom: "", dTo: "" }; }
  if (c.period === "custom") {
    if (c.dateFrom || c.dateTo) return { lo: -Infinity, hi: Infinity, dFrom: c.dateFrom, dTo: c.dateTo };
    const a = idxOf(c.fromM), b = idxOf(c.toM);
    return { lo: Math.min(a, b), hi: Math.max(a, b), dFrom: "", dTo: "" };
  }
  const t = idxOf(todayKey());
  return { lo: t, hi: t, dFrom: "", dTo: "" };
}

const byTime = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : idxOf(x.month) - idxOf(y.month) || x.seq - y.seq);
const isMulti = (v) => !(v.lines.filter((l) => l.side === "debit").length === 1 && v.lines.filter((l) => l.side === "credit").length === 1);

export function runSearch(all, c, accountsById) {
  const r = rangeOf(c);
  const inPeriod = (v) => {
    if (r.dFrom || r.dTo) return (!r.dFrom || v.date >= r.dFrom) && (!r.dTo || v.date <= r.dTo);
    const i = idxOf(v.month);
    return i >= r.lo && i <= r.hi;
  };
  const memoQ = norm(c.memo || "").trim();
  const min = parseAmount(c.min), max = parseAmount(c.max);
  const amountOk = (n) => (!(min > 0) || n >= min) && (!(max > 0) || n <= max);
  const voucherOk = (v) => {
    if (c.fields.length && !c.fields.includes(v.fieldId)) return false;
    if (c.parties.length && !c.parties.includes(v.partyId)) return false;
    if (memoQ && !norm(v.lines.map((l) => l.memo || "").join(" ")).includes(memoQ)) return false;
    if (c.biz.length && !v.lines.some((l) => c.biz.includes(l.biz))) return false;
    if (c.tax.length && !v.lines.some((l) => c.tax.includes(String(l.tax || 0)))) return false;
    if ((c.kinds || []).length && !c.kinds.includes(kindOf(v))) return false;
    if (c.marks.length) {
      const hit = c.marks.some((m) => (m === "late" ? v.late : m === "multi" ? isMulti(v) : v.mark === m));
      if (!hit) return false;
    }
    return true;
  };
  const sorted = [...all].sort(byTime);
  const vs = sorted.filter((v) => inPeriod(v) && voucherOk(v));
  const accSet = new Set(c.accounts);
  let rows, opening = null;
  if (accSet.size) {
    rows = [];
    vs.forEach((v) => v.lines.forEach((l, i) => {
      if (!accSet.has(l.accId)) return;
      if (c.side === "debit" && l.side !== "debit") return;
      if (c.side === "credit" && l.side !== "credit") return;
      if (!amountOk(l.amount)) return;
      rows.push({ v, l, i });
    }));
    if (accSet.size === 1) {
      // 残高の積み上げ：貸借の科目は期間より前から、損益の科目は期間の初めから
      const accId = c.accounts[0], a = accountsById[accId];
      const sign = a && a.side === "credit" ? -1 : 1;
      let bal = 0;
      const balAt = new Map();
      let started = false;
      sorted.forEach((v) => {
        const inP = inPeriod(v);
        if (!inP && !isBS(a)) return;
        if (!inP && r.dFrom === "" && idxOf(v.month) > r.hi) return;
        if (r.dTo && v.date > r.dTo) return;
        if (inP && !started) { started = true; opening = bal; }
        v.lines.forEach((l, i) => {
          if (l.accId !== accId) return;
          bal += (l.side === "debit" ? l.amount : -l.amount) * sign;
          balAt.set(v.id + ":" + i, bal);
        });
      });
      if (opening === null) opening = bal;
      rows.forEach((x) => { x.bal = balAt.get(x.v.id + ":" + x.i); });
    }
  } else {
    rows = vs.map((v) => ({ v, total: v.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0) }))
      .filter((x) => amountOk(x.total));
  }
  return { rows, opening, ledgerMode: accSet.size > 0, single: accSet.size === 1 };
}

// ---------- 保存した検索 ----------
const SEED_SEARCHES = () => {
  const uber = state.parties.find((p) => norm(p.name) === "uber");
  const exp = state.accounts.filter((a) => a.kind === "expense").map((a) => a.id);
  return [
    { id: "s_uber", name: "Uber売上 全期間", cond: { ...defaultCond(), period: "all", accounts: state.accountsById.acc_48 ? ["acc_48"] : [], parties: uber ? [uber.id] : [] } },
    { id: "s_over10k", name: "1万円以上の支出", cond: { ...defaultCond(), period: "all", accounts: exp, side: "debit", min: "10000" } }
  ];
};

async function loadSaved() {
  if (state.savedSearches) return;
  try {
    const snap = await getDoc(doc(col("meta"), "searches"));
    if (snap.exists() && Array.isArray(snap.data().list)) state.savedSearches = snap.data().list;
    else { state.savedSearches = SEED_SEARCHES(); await persistSaved(); }
  } catch (err) {
    state.savedSearches = SEED_SEARCHES();
  }
}
async function persistSaved() {
  await setDoc(doc(col("meta"), "searches"), { list: state.savedSearches });
}

// ---------- 画面 ----------
export async function renderLedger() {
  $("view").innerHTML = `<div class="placeholder">読み込み中…</div>`;
  let all;
  try { all = await loadAllVouchers(); await loadSaved(); }
  catch (err) { showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (state.tab !== "ledger") return;
  if (!state.lg) state.lg = { cond: defaultCond(), mode: "none" };
  if (!state.lg.cond) state.lg.cond = defaultCond(); // B/S・P/L・試算表から先に来たときの保険
  const L = state.lg;
  if (L.preset) {
    const p = L.preset; L.preset = null;
    L.cond = { ...defaultCond(), accounts: [p.accountId], side: p.side || "both", period: "custom", fromM: p.fromM, toM: p.toM };
  }
  drawScreen(all);
}

function drawScreen(all) {
  const L = state.lg;
  const C = () => L.cond;
  const savedOpts = () => `<option value="">保存した検索…</option>` + state.savedSearches.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("view").innerHTML = `
    <div class="lgbox panel">
      <div class="lgrow">
        <label>期間 <select id="lg-period"><option value="month">今月</option><option value="year">今年</option><option value="all">全期間</option><option value="custom">月度・日付を指定</option></select></label>
        <span id="lg-custom" hidden>
          <input type="month" id="lg-fromM"> 〜 <input type="month" id="lg-toM">
          　または日付 <input type="date" id="lg-dFrom"> 〜 <input type="date" id="lg-dTo">
        </span>
        <span class="spacer"></span>
        <select id="lg-saved">${savedOpts()}</select>
        <input type="text" id="lg-name" placeholder="検索の名前" size="14">
        <button type="button" class="sub" id="lg-save">保存</button>
        <button type="button" class="sub" id="lg-up" title="上へ">↑</button>
        <button type="button" class="sub" id="lg-down" title="下へ">↓</button>
        <button type="button" class="sub" id="lg-rename">名前変更</button>
        <button type="button" class="danger" id="lg-del">削除</button>
      </div>
      <div class="lggrid">
        <div class="in"><label>科目（複数選べます）</label><div id="lg-acc" class="multi"></div>
          <select id="lg-side"><option value="both">借方でも貸方でも</option><option value="debit">借方だけ</option><option value="credit">貸方だけ</option></select></div>
        <div class="in"><label>分野</label><div id="lg-fld" class="multi"></div></div>
        <div class="in"><label>取引先</label><div id="lg-pty" class="multi"></div></div>
        <div class="in"><label>金額（同じ金額を入れるとちょうど）</label>
          <div class="amtrange"><input type="text" id="lg-min" inputmode="numeric" placeholder="以上"> 〜 <input type="text" id="lg-max" inputmode="numeric" placeholder="以下"></div></div>
        <div class="in"><label>摘要の文字</label><input type="text" id="lg-memo" autocomplete="off"></div>
        <div class="in"><label>区分・税率</label><div class="checks" id="lg-chk1">
          <label><input type="checkbox" data-g="biz" value="biz">事業</label><label><input type="checkbox" data-g="biz" value="life">生活</label>
          <label><input type="checkbox" data-g="tax" value="0">税なし</label><label><input type="checkbox" data-g="tax" value="8">8%</label><label><input type="checkbox" data-g="tax" value="10">10%</label></div></div>
        <div class="in"><label>種別</label><div class="checks" id="lg-chk3">${KINDS.map(([k, n]) => `<label><input type="checkbox" data-g="kinds" value="${k}">${esc(n)}</label>`).join("")}</div></div>
        <div class="in"><label>印</label><div class="checks" id="lg-chk2">${MARKS.map(([v, n]) => `<label><input type="checkbox" data-g="marks" value="${esc(v)}">${esc(n)}</label>`).join("")}</div></div>
      </div>
      <div class="lgrow"><button type="button" class="sub" id="lg-clear">条件をクリア</button>
        <span class="note">同じ条件の中で複数選ぶと「どれか」、違う条件どうしは「すべて満たす」です。</span><span class="spacer"></span>
        <label class="note">小計 <select id="lg-sub"><option value="none">なし</option><option value="month">月別</option><option value="party">取引先別</option></select></label>
        <button type="button" class="sub" id="lg-csv">CSV</button><button type="button" class="sub" id="lg-print">印刷</button></div>
      <p id="lg-msg" class="note"></p>
    </div>
    <div class="panel nopad"><div class="panel-head"><h3><span class="bar"></span><span id="lg-title">結果</span></h3></div>
      <div class="lgscroll"><div class="lgtable" id="lg-grid"><div id="lg-head"></div><div id="lg-body"></div><div id="lg-foot"></div></div></div>
      <div id="lg-subtotal"></div></div>`;

  // --- 科目・分野・取引先のチップ入力 ---
  const labelAcc = (id) => { const a = state.accountsById[id]; return a ? `${a.no} ${a.name}` : ""; };
  const labelFld = (id) => { const f = state.fieldsById[id]; return f ? `${f.no} ${hk(f.name)}` : ""; };
  const labelPty = (id) => { const p = state.partiesById[id]; return p ? hk(p.name) : ""; };
  const multiDefs = [
    ["lg-acc", "accounts", labelAcc, () => state.accounts.filter((a) => !isBlank(a)).map((a) => ({ id: a.id, no: a.no, name: a.name, kana: a.kana || "", count: 0, html: accChip(a) }))],
    ["lg-fld", "fields", labelFld, () => state.fields.map((f) => ({ id: f.id, no: f.no, name: f.name, kana: "", count: 0, html: `<span class="fd"><b>${esc(f.no)}</b>${esc(hk(f.name))}</span>` }))],
    ["lg-pty", "parties", labelPty, () => state.parties.map((p) => ({ id: p.id, no: null, name: p.name, kana: p.kana || "", count: p.count || 0, spot: !!p.spot, html: `<span class="pn">${esc(hk(p.name))}</span>` }))]
  ];
  const chipDraws = [];
  multiDefs.forEach(([hid, key, labelOf, getItems]) => {
    const host = $(hid);
    host.innerHTML = `<div class="chips"></div><div class="cmb"></div>`;
    const chipsEl = host.querySelector(".chips");
    const draw = () => {
      chipsEl.innerHTML = C()[key].map((id) => `<span class="chip2">${esc(labelOf(id))}<button type="button" data-rm="${esc(id)}" aria-label="外す">×</button></span>`).join("");
    };
    chipsEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      C()[key] = C()[key].filter((x) => x !== b.dataset.rm);
      draw(); update();
    });
    const cb = createCombo(host.querySelector(".cmb"), {
      getItems, labelOf,
      onChange(v) { if (v.id && !C()[key].includes(v.id)) { C()[key].push(v.id); draw(); update(); } cb.clear(); },
      onEnter() {}
    });
    chipDraws.push(draw);
  });

  // --- 他の入力欄 ---
  const bindVal = (id, key, ev = "input") => $(id).addEventListener(ev, (e) => { C()[key] = e.target.value; update(); });
  bindVal("lg-side", "side", "change"); bindVal("lg-min", "min"); bindVal("lg-max", "max"); bindVal("lg-memo", "memo");
  bindVal("lg-dFrom", "dateFrom", "change"); bindVal("lg-dTo", "dateTo", "change");
  $("lg-period").addEventListener("change", (e) => { C().period = e.target.value; syncControls(); update(); });
  $("lg-fromM").addEventListener("change", (e) => { if (e.target.value) { C().fromM = ymToKey(e.target.value); update(); } });
  $("lg-toM").addEventListener("change", (e) => { if (e.target.value) { C().toM = ymToKey(e.target.value); update(); } });
  document.querySelectorAll(".checks input").forEach((cb) => cb.addEventListener("change", () => {
    const g = cb.dataset.g;
    C()[g] = [...document.querySelectorAll(`.checks input[data-g="${g}"]:checked`)].map((x) => x.value);
    update();
  }));
  $("lg-sub").addEventListener("change", (e) => { L.mode = e.target.value; update(); });
  $("lg-clear").addEventListener("click", () => { L.cond = defaultCond(); $("lg-name").value = ""; $("lg-saved").value = ""; syncControls(); update(); });
  $("lg-print").addEventListener("click", () => window.print());

  function syncControls() {
    const c = C();
    $("lg-period").value = c.period;
    $("lg-custom").hidden = c.period !== "custom";
    $("lg-fromM").value = keyToYm(c.fromM); $("lg-toM").value = keyToYm(c.toM);
    $("lg-dFrom").value = c.dateFrom; $("lg-dTo").value = c.dateTo;
    $("lg-side").value = c.side; $("lg-min").value = c.min; $("lg-max").value = c.max; $("lg-memo").value = c.memo;
    document.querySelectorAll(".checks input").forEach((cb) => { cb.checked = (c[cb.dataset.g] || []).includes(cb.value); });
    $("lg-sub").value = L.mode;
    chipDraws.forEach((d) => d());
  }

  // --- 保存した検索 ---
  const refreshSaved = (selId) => { $("lg-saved").innerHTML = savedOpts(); $("lg-saved").value = selId || ""; };
  const msgSaved = (m) => { $("lg-msg").textContent = m || ""; };
  $("lg-saved").addEventListener("change", (e) => {
    const s = state.savedSearches.find((x) => x.id === e.target.value);
    if (!s) return;
    L.cond = { ...defaultCond(), ...JSON.parse(JSON.stringify(s.cond)) };
    $("lg-name").value = s.name;
    syncControls(); update();
  });
  const save = async (fn) => {
    try { await persistSaved(); fn && fn(); } catch (err) { msgSaved("保存に失敗しました：" + (err.code || err.message)); }
  };
  $("lg-save").addEventListener("click", async () => {
    const name = $("lg-name").value.trim();
    if (!name) return msgSaved("検索の名前を入れてから「保存」を押してください。");
    const cond = JSON.parse(JSON.stringify(C()));
    const hit = state.savedSearches.find((s) => s.name === name);
    let id;
    if (hit) { hit.cond = cond; id = hit.id; } else { id = "s_" + Date.now().toString(36); state.savedSearches.push({ id, name, cond }); }
    await save(() => { refreshSaved(id); msgSaved(hit ? `「${name}」を上書きしました。` : `「${name}」を保存しました。`); });
  });
  $("lg-rename").addEventListener("click", async () => {
    const s = state.savedSearches.find((x) => x.id === $("lg-saved").value);
    const name = $("lg-name").value.trim();
    if (!s) return msgSaved("名前を変える検索を、上の一覧から選んでください。");
    if (!name) return msgSaved("新しい名前を入れてください。");
    s.name = name;
    await save(() => { refreshSaved(s.id); msgSaved("名前を変えました。"); });
  });
  $("lg-del").addEventListener("click", async () => {
    const id = $("lg-saved").value;
    const s = state.savedSearches.find((x) => x.id === id);
    if (!s) return msgSaved("削除する検索を、上の一覧から選んでください。");
    state.savedSearches = state.savedSearches.filter((x) => x.id !== id);
    await save(() => { refreshSaved(""); $("lg-name").value = ""; msgSaved(`「${s.name}」を削除しました。`); });
  });
  const move = async (d) => {
    const i = state.savedSearches.findIndex((x) => x.id === $("lg-saved").value);
    const j = i + d;
    if (i < 0 || j < 0 || j >= state.savedSearches.length) return;
    [state.savedSearches[i], state.savedSearches[j]] = [state.savedSearches[j], state.savedSearches[i]];
    await save(() => refreshSaved(state.savedSearches[j].id));
  };
  $("lg-up").addEventListener("click", () => move(-1));
  $("lg-down").addEventListener("click", () => move(1));

  // --- 結果 ---
  let last = null;
  function counterpart(v, l) {
    const opp = v.lines.filter((x) => x.side !== l.side);
    const ids = [...new Set(opp.map((x) => x.accId))];
    if (ids.length === 1 && state.accountsById[ids[0]]) return accChip(state.accountsById[ids[0]]);
    const tip = opp.map((x) => `${(state.accountsById[x.accId] || {}).name || "?"} ${yen(x.amount)}`).join("、");
    return `<span class="ac" title="${esc(tip)}">諸口</span>`;
  }
  const accsOf = (v, side) => [...new Set(v.lines.filter((l) => l.side === side).map((l) => l.accId))]
    .map((id) => state.accountsById[id]).filter(Boolean).map((a) => accChip(a)).join(" ");
  const memoOf = (v, l) => hk(l ? l.memo || "" : [...new Set(v.lines.map((x) => x.memo).filter(Boolean))].join(" ／ "));
  const dateCell = (v) => { const d = new Date(v.date + "T00:00:00"); return `${parseInt(v.date.slice(5, 7), 10)}/${parseInt(v.date.slice(8, 10), 10)}<span class="wd ${d.getDay() === 6 ? "sat" : d.getDay() === 0 ? "sun" : ""}">${WD[d.getDay()]}</span>`; };

  function update() {
    const res = runSearch(all, C(), state.accountsById);
    last = res;
    const { rows, ledgerMode, single } = res;
    const LIMIT = 1000;
    const shown = rows.slice(0, LIMIT);
    const c = (html, cls = "") => `<div class="${cls}">${html}</div>`;
    const common = (v) => c(esc(v.month + "-" + v.seq), "num muted");
    const rest = (v, l) => c(v.fieldId && state.fieldsById[v.fieldId] ? `<span class="fd"><b>${esc(state.fieldsById[v.fieldId].no)}</b>${esc(hk(state.fieldsById[v.fieldId].name))}</span>` : "") +
      c(esc(hk((state.partiesById[v.partyId] || {}).name || ""))) + c(esc(memoOf(v, l)) + (v.late ? ' <span class="chip late">後日記帳</span>' : "") + kindChip(v), "memo");
    let cols, head, body, foot;
    const n = rows.length;
    if (ledgerMode) {
      cols = single ? "100px 100px minmax(170px,1.3fr) minmax(120px,1fr) minmax(110px,1fr) minmax(140px,1.4fr) 100px 100px 110px"
        : "100px 100px minmax(170px,1.3fr) minmax(120px,1fr) minmax(110px,1fr) minmax(140px,1.4fr) 100px 100px";
      head = ["日付", "伝番", "相手科目", "分野", "取引先", "摘要"].map((t) => c(t)).join("") + c("借方", "r") + c("貸方", "r") + (single ? c("残高", "r") : "");
      body = (single ? `<div class="lgr open">${c("月初（期間の初め）残高", "r span8")}${c(yen(res.opening), "r num")}</div>` : "") +
        shown.map((x, k) => `<div class="lgr ${k % 2 ? "alt" : ""}" data-vid="${esc(x.v.id)}">${c(dateCell(x.v))}${common(x.v)}${c(counterpart(x.v, x.l))}${rest(x.v, x.l)}` +
          c(x.l.side === "debit" ? yen(x.l.amount) : "", "r num") + c(x.l.side === "credit" ? yen(x.l.amount) : "", "r num") + (single ? c(yen(x.bal), "r num b") : "") + `</div>`).join("");
      const d = rows.reduce((sum, x) => sum + (x.l.side === "debit" ? x.l.amount : 0), 0);
      const cr = rows.reduce((sum, x) => sum + (x.l.side === "credit" ? x.l.amount : 0), 0);
      foot = `<div class="lgr tot">${c(`${n}件　平均 ¥${yen(n ? Math.round((d + cr) / n) : 0)}`, "span6")}${c(yen(d), "r num")}${c(yen(cr), "r num")}${single ? c(yen(shown.length ? rows[rows.length - 1].bal : res.opening), "r num") : ""}</div>`;
    } else {
      cols = "100px 100px minmax(170px,1.4fr) minmax(170px,1.4fr) minmax(120px,1fr) minmax(110px,1fr) minmax(140px,1.4fr) 110px";
      head = ["日付", "伝番", "借方", "貸方", "分野", "取引先", "摘要"].map((t) => c(t)).join("") + c("金額", "r");
      body = shown.map((x, k) => `<div class="lgr ${k % 2 ? "alt" : ""}" data-vid="${esc(x.v.id)}">${c(dateCell(x.v))}${common(x.v)}${c(accsOf(x.v, "debit"))}${c(accsOf(x.v, "credit"))}${rest(x.v, null)}${c(yen(x.total), "r num")}</div>`).join("");
      const t = rows.reduce((sum, x) => sum + x.total, 0);
      foot = `<div class="lgr tot">${c(`${n}件　平均 ¥${yen(n ? Math.round(t / n) : 0)}`, "span7")}${c(yen(t), "r num")}</div>`;
    }
    if (!shown.length) body += `<div class="lgempty">条件に合う仕訳はありません。</div>`;
    $("lg-grid").style.setProperty("--cols", cols);
    $("lg-head").innerHTML = `<div class="lgr lgh">${head}</div>`;
    $("lg-body").innerHTML = body;
    $("lg-foot").innerHTML = foot;
    $("lg-title").textContent = `結果　${n}件${n > LIMIT ? `（先頭の${LIMIT}件を表示）` : ""}`;

    // 小計
    const sub = $("lg-subtotal");
    if (L.mode === "none" || !n) sub.innerHTML = "";
    else {
      const groups = new Map();
      rows.forEach((x) => {
        const k = L.mode === "month" ? x.v.month + "月度" : hk((state.partiesById[x.v.partyId] || {}).name || "（取引先なし）");
        const g = groups.get(k) || { n: 0, d: 0, c: 0, t: 0 };
        g.n++;
        if (ledgerMode) { if (x.l.side === "debit") g.d += x.l.amount; else g.c += x.l.amount; } else g.t += x.total;
        groups.set(k, g);
      });
      const list = [...groups.entries()];
      if (L.mode === "party") list.sort((a, b) => (b[1].d + b[1].c + b[1].t) - (a[1].d + a[1].c + a[1].t));
      const sc = ledgerMode ? "180px 90px 130px 130px" : "180px 90px 130px";
      const cell = (h, cls = "") => `<div class="${cls}">${h}</div>`;
      sub.innerHTML = `<div class="lgsub" style="--cols:${sc}"><div class="lgr lgh">${cell(L.mode === "month" ? "月度" : "取引先")}${cell("件数", "r")}${ledgerMode ? cell("借方", "r") + cell("貸方", "r") : cell("金額", "r")}</div>` +
        list.map(([k, g]) => `<div class="lgr">${cell(esc(k))}${cell(g.n, "r num")}${ledgerMode ? cell(yen(g.d), "r num") + cell(yen(g.c), "r num") : cell(yen(g.t), "r num")}</div>`).join("") + `</div>`;
    }
  }

  $("lg-body").addEventListener("click", (e) => {
    const tr = e.target.closest("[data-vid]");
    if (!tr) return;
    const v = all.find((x) => x.id === tr.dataset.vid);
    if (v) openEdit(v, () => renderLedger());
  });
  $("lg-csv").addEventListener("click", () => {
    if (!last) return;
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const acc = (id) => (state.accountsById[id] || {}).name || "";
    const out = [];
    if (last.ledgerMode) {
      out.push(["日付", "伝番", "相手科目", "分野", "取引先", "摘要", "借方", "貸方"].map(q).join(","));
      last.rows.forEach((x) => out.push([x.v.date, x.v.month + "-" + x.v.seq, q([...new Set(x.v.lines.filter((l) => l.side !== x.l.side).map((l) => acc(l.accId)))].join("・")),
        q((state.fieldsById[x.v.fieldId] || {}).name || ""), q((state.partiesById[x.v.partyId] || {}).name || ""), q(x.l.memo || ""),
        x.l.side === "debit" ? x.l.amount : "", x.l.side === "credit" ? x.l.amount : ""].join(",")));
    } else {
      out.push(["日付", "伝番", "借方", "貸方", "分野", "取引先", "摘要", "金額"].map(q).join(","));
      last.rows.forEach((x) => out.push([x.v.date, x.v.month + "-" + x.v.seq,
        q([...new Set(x.v.lines.filter((l) => l.side === "debit").map((l) => acc(l.accId)))].join("・")),
        q([...new Set(x.v.lines.filter((l) => l.side === "credit").map((l) => acc(l.accId)))].join("・")),
        q((state.fieldsById[x.v.fieldId] || {}).name || ""), q((state.partiesById[x.v.partyId] || {}).name || ""),
        q(memoOf(x.v, null)), x.total].join(",")));
    }
    const blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "元帳・検索.csv";
    document.body.appendChild(a); a.click(); a.remove();
  });

  syncControls();
  update();
}
