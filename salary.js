// 給与入力（手順I11b）：給与明細と同じ並びで入力し、複合仕訳を1枚作る（kind="salary"）
import { state, col, db, fetchMonthVouchers, loadAllVouchers, loadVouchers, isClosed } from "./state.js?v=0.2I11f";
import { $, esc, yen, ymd, monthOf, showError } from "./util.js?v=0.2I11f";
import { renderTax } from "./residenttax.js?v=0.2I11f";
import { renderClean } from "./salaryclean.js?v=0.2I11f";
import { shiftBusiness } from "./holidays.js?v=0.2I11f";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const accByNo = (no) => state.accounts.find((a) => a.no === no);
const accLabel = (a) => (a ? `${a.no} ${a.name}` : "？");

// 初期の入力欄（設定で自由に増減できる）。group: pay=支給 / ded=控除。commute=通勤手当（仮払交通費の残高の範囲で25、差額は49）
export function defaultCfg() {
  const id = (no) => (accByNo(no) || {}).id || "";
  const p = state.parties.find((x) => /東邦ガス/.test(x.name || ""));
  const f = state.fields.find((x) => x.no === 61);
  const mk = (key, label, group, no, side, commute) => ({ key, label, group, accId: id(no), side, ...(commute ? { commute: true } : {}) });
  return {
    items: [
      mk("base", "基準賃金計", "pay", 90, "credit"), mk("extra", "基準外賃金計", "pay", 90, "credit"), mk("commute", "通勤手当", "pay", 90, "credit", true), mk("reimb", "その他支払い（立替の精算）", "pay", 22, "credit"),
      mk("kenpo", "健康保険料", "ded", 95, "debit"), mk("tokutei", "特定保険料", "ded", 95, "debit"), mk("kaigo", "介護保険料", "ded", 95, "debit"), mk("nenkin", "厚生年金", "ded", 95, "debit"), mk("koyo", "雇用保険料", "ded", 95, "debit"),
      mk("shotoku", "所得税", "ded", 94, "debit"), mk("juminzei", "住民税", "ded", 94, "debit")
    ],
    banks: [id(12)].filter(Boolean),
    partyId: p ? p.id : "", fieldId: f ? f.id : "", payDay: 20, last: null, ver: 3
  };
}

// 仮払交通費（25）の残高（date 以前。除く: 直す仕訳のid）
export function balance25(list, date, exceptId) {
  const a = accByNo(25); if (!a) return 0;
  let b = 0;
  list.forEach((v) => {
    if (v.deleted || v.id === exceptId || (v.date || "") > date) return;
    (v.lines || []).forEach((l) => { if (l.accId === a.id) b += l.side === "debit" ? l.amount : -l.amount; });
  });
  return b;
}

// 画面の入力から仕訳の行を作る（画面に依存しない）。S: {vals:{key:amount}, banks:[{accId,amount}], extra:[{side,accId,amount,memo}], bonus}
export function buildSalary(S, cfg, bal25) {
  const lines = [];
  const tags = S.bonus ? ["賞与"] : [];
  const push = (side, accId, amount, memo) => { if (accId && amount) lines.push({ side, accId, amount, tax: 0, memo: memo || "", tags: [...tags], biz: "life" }); };
  let pay = 0, ded = 0, c25 = 0, c49 = 0;
  cfg.items.forEach((it) => {
    const n = Math.round(Number((S.vals || {})[it.key]) || 0);
    if (!n) return;
    if (it.group === "pay") {
      pay += n;
      if (it.commute) {
        const c = Math.min(Math.max(bal25, 0), Math.max(n, 0));
        c25 = c; c49 = n - c;
        push("credit", (accByNo(25) || {}).id, c, it.label); push("credit", (accByNo(49) || {}).id, c49, it.label + "の差額");
      } else push(n < 0 ? (it.side === "credit" ? "debit" : "credit") : it.side, it.accId, Math.abs(n), it.label);
    } else {
      ded += n;
      push(n < 0 ? (it.side === "debit" ? "credit" : "debit") : it.side, it.accId, Math.abs(n), it.label);
    }
  });
  const net = pay - ded;
  let bank = 0;
  (S.banks || []).forEach((b) => { const n = Math.round(Number(b.amount) || 0); bank += n; push("debit", b.accId, n, "振込"); });
  (S.extra || []).forEach((e) => push(e.side, e.accId, Math.round(Number(e.amount) || 0), e.memo || "追加"));
  const debit = lines.filter((l) => l.side === "debit").reduce((x, l) => x + l.amount, 0);
  const credit = lines.filter((l) => l.side === "credit").reduce((x, l) => x + l.amount, 0);
  return { lines, pay, ded, net, bank, debit, credit, c25, c49, balanced: debit === credit && debit > 0 };
}

export const salaryId = (date, bonus) => `${bonus ? "bonus" : "salary"}_${date.slice(2, 4)}_${parseInt(date.slice(5, 7), 10)}`;

// 支給日の初期値：その月の payDay 日。休みなら前の平日
export function defaultPayDate(ym, payDay) {
  const d = `${ym}-${String(payDay || 20).padStart(2, "0")}`;
  return shiftBusiness(d, "prev");
}

async function loadCfg() {
  const snap = await getDoc(doc(col("meta"), "salaryForm"));
  const base = defaultCfg();
  if (!snap.exists()) return base;
  const saved = snap.data() || {};
  const c = { ...base, ...saved };
  // 古い設定（ver 2 より前）には、特定保険料・介護保険料の欄を、健康保険料のあとに足す
  if (!(saved.ver >= 2)) {
    const add = base.items.filter((b) => (b.key === "tokutei" || b.key === "kaigo") && !c.items.some((i) => i.key === b.key));
    const at = c.items.findIndex((i) => i.key === "kenpo");
    c.items.splice(at >= 0 ? at + 1 : c.items.length, 0, ...add);
  }
  // ver 3：「その他支払い（立替の精算）」の欄を、通勤手当のあとに足す
  if (!(saved.ver >= 3) && !c.items.some((i) => i.key === "reimb")) {
    const at = c.items.findIndex((i) => i.key === "commute");
    c.items.splice(at >= 0 ? at + 1 : c.items.length, 0, base.items.find((b) => b.key === "reimb"));
  }
  c.ver = 3;
  return c;
}
const parseN = (s) => { const t = String(s).replace(/[,，\s¥円]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/[−－ー]/g, "-"); const n = Number(t); return Number.isFinite(n) ? Math.round(n) : 0; };
const accOptions = (sel) => state.accounts.map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${esc(accLabel(a))}</option>`).join("");

let SALTAB = "input";
let CFG = null, S = null, LIST = [], EXIST = null, PRESET = "";
// 月末の画面などから、対象月を決めて給与タブを開く（month は "26.11" の形）
export function presetSalary(month) { const [y, m] = month.split("."); PRESET = `20${y}-${String(m).padStart(2, "0")}`; }
// 先月末の日付（支給日が属する月の、ひとつ前の月の最終日）
export function lastDayOfPrevMonth(date) { const [y, m] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); }

const tabsHtml = () => `<div class="subtabs"><button type="button" data-st="input" class="${SALTAB === "input" ? "active" : ""}">給与</button><button type="button" data-st="tax" class="${SALTAB === "tax" ? "active" : ""}">住民税（自分で納付）</button><button type="button" data-st="clean" class="${SALTAB === "clean" ? "active" : ""}">古い給与の整理</button></div>`;
function wireTabs(host) {
  host.querySelectorAll("button[data-st]").forEach((b) => b.addEventListener("click", () => { SALTAB = b.dataset.st; renderSalary(); }));
}

export async function renderSalary() {
  const host = $("view");
  if (SALTAB === "tax") {
    host.innerHTML = `${tabsHtml()}<section class="panel"><h3><span class="bar"></span>住民税（自分で納付）</h3><div id="sal-tax"></div></section>`;
    wireTabs(host);
    await renderTax($("sal-tax"));
    return;
  }
  if (SALTAB === "clean") {
    host.innerHTML = `${tabsHtml()}<section class="panel"><h3><span class="bar"></span>古い給与の整理</h3><div id="sal-clean"></div></section>`;
    wireTabs(host);
    await renderClean($("sal-clean"), { goSalary: (month) => { presetSalary(month); SALTAB = "input"; renderSalary(); } });
    return;
  }
  host.innerHTML = `<section class="panel"><p class="note">読み込んでいます…</p></section>`;
  try { CFG = await loadCfg(); LIST = await loadAllVouchers(); }
  catch (err) { host.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  if (!S) {
    const t = ymd(new Date());
    S = { ym: t.slice(0, 7), bonus: false, date: "", vals: {}, banks: CFG.banks.map((a) => ({ accId: a, amount: "", auto: true })), extra: [], slip: "", recover: "" };
  }
  if (PRESET) { S.ym = PRESET; S.date = ""; PRESET = ""; }
  if (!S.date) S.date = defaultPayDate(S.ym, CFG.payDay);
  await checkExisting();
  draw(host);
}

async function checkExisting() {
  EXIST = null;
  const id = salaryId(S.date, S.bonus);
  const snap = await getDoc(doc(col("vouchers"), id));
  if (snap.exists() && !(snap.data() || {}).deleted) EXIST = { id, ...snap.data() };
}

function draw(host) {
  const grp = (g) => CFG.items.filter((it) => it.group === g).map((it) => `<label>${esc(it.label)}</label><input type="text" inputmode="numeric" data-k="${esc(it.key)}" value="${S.vals[it.key] ?? ""}">`).join("");
  host.innerHTML = `${tabsHtml()}
  <section class="panel" id="sal">
    <h3><span class="bar"></span>給与入力 <span class="note" style="font-weight:400">給与明細と同じ並びで入れると、複合仕訳を1枚作ります</span></h3>
    <div class="toolbar">
      <label>対象月 <input type="month" id="sal-ym" value="${esc(S.ym)}"></label>
      <label>支給日 <input type="date" id="sal-date" value="${esc(S.date)}"></label>
      <label><select id="sal-bonus"><option value="0"${S.bonus ? "" : " selected"}>給与</option><option value="1"${S.bonus ? " selected" : ""}>賞与</option></select></label>
      <button type="button" id="sal-last">前回の内容を入れる</button>
    </div>
    <p class="note" id="sal-exist"></p>
    <div class="salgrid">
      <div class="salbox"><h4>支給</h4><div class="salg">${grp("pay")}</div><div class="salg" style="margin-top:6px"><label>仮払交通費（先月分）を回収</label><input type="text" inputmode="numeric" id="sal-rec" value=""></div>
        <p class="note" id="sal-recnote"></p>
        <div class="saltot"><span>給与支給額計</span><span id="sal-pay">0</span></div></div>
      <div class="salbox"><h4>控除</h4><div class="salg">${grp("ded")}</div><div class="saltot"><span>控除額計</span><span id="sal-ded">0</span></div></div>
      <div class="salbox"><h4>振込</h4><div class="salg" id="sal-banks"></div>
        <div class="saltot"><span>当月支給額</span><span id="sal-net">0</span></div>
        <div class="salg" style="margin-top:6px"><label>明細の当月支給額（確認用・空でもOK）</label><input type="text" inputmode="numeric" id="sal-slip" value="${S.slip}"></div>
        <p class="note" id="sal-chk"></p></div>
    </div>
    <h4 style="margin:14px 0 6px">できる仕訳（1枚・種別：給与）</h4>
    <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>借方</th><th class="amt">金額</th><th>貸方</th><th class="amt">金額</th><th>メモ</th></tr></thead><tbody id="sal-prev"></tbody></table></div>
    <p class="note" id="sal-bal"></p>
    <h4 style="margin:14px 0 6px">この月だけ行を追加（イレギュラーな収入・費用など）</h4>
    <div id="sal-extra"></div>
    <div class="actions" style="justify-content:flex-start"><button type="button" id="sal-addx">行を追加</button><button type="button" class="primary" id="sal-save">記帳する</button></div>
    <p class="note" id="sal-msg"></p>
    <details style="margin-top:16px"><summary>入力欄の設定（項目の追加・削除、勤務先、振込先）</summary><div id="sal-cfg"></div></details>
  </section>`;
  wireTabs(host); drawBanks(); drawExtra(); drawCfg(); recalc();
  $("sal-ym").addEventListener("change", async (e) => { S.ym = e.target.value || S.ym; S.recover = ""; S.date = defaultPayDate(S.ym, CFG.payDay); $("sal-date").value = S.date; await checkExisting(); recalc(); });
  $("sal-date").addEventListener("change", async (e) => { S.date = e.target.value; S.recover = ""; await checkExisting(); recalc(); });
  $("sal-bonus").addEventListener("change", async (e) => { S.bonus = e.target.value === "1"; await checkExisting(); recalc(); });
  $("sal").querySelectorAll("input[data-k]").forEach((i) => i.addEventListener("input", () => { S.vals[i.dataset.k] = parseN(i.value) || ""; recalc(); }));
  $("sal-rec").addEventListener("input", (e) => { S.recover = e.target.value.trim() === "" ? "" : parseN(e.target.value); recalc(); });
  $("sal-slip").addEventListener("input", (e) => { S.slip = e.target.value; recalc(); });
  $("sal-addx").addEventListener("click", () => { S.extra.push({ side: "debit", accId: "", amount: "", memo: "" }); drawExtra(); recalc(); });
  $("sal-save").addEventListener("click", save);
  $("sal-last").addEventListener("click", () => {
    const l = CFG.last; if (!l) { $("sal-msg").textContent = "前回の内容はまだありません。"; return; }
    S.vals = { ...l.vals }; S.banks = (l.banks || []).map((b) => ({ ...b, auto: true })); drawBanks(); host.querySelectorAll("input[data-k]").forEach((i) => { i.value = S.vals[i.dataset.k] ?? ""; }); recalc();
  });
}

function drawBanks() {
  const el = $("sal-banks");
  el.innerHTML = S.banks.map((b, i) => `<select data-bi="${i}" data-f="acc">${accOptions(b.accId)}</select><input type="text" inputmode="numeric" data-bi="${i}" data-f="amt" value="${b.amount === "" ? "" : b.amount}">`).join("") +
    `<span></span><span><button type="button" id="sal-addb">口座を追加</button>${S.banks.length > 1 ? ` <button type="button" id="sal-delb">最後を削除</button>` : ""}</span>`;
  el.querySelectorAll("[data-bi]").forEach((x) => x.addEventListener(x.tagName === "SELECT" ? "change" : "input", () => {
    const b = S.banks[+x.dataset.bi];
    if (x.dataset.f === "acc") b.accId = x.value; else { b.amount = parseN(x.value); b.auto = false; }
    recalc();
  }));
  $("sal-addb").addEventListener("click", () => { S.banks.push({ accId: S.banks[0] ? S.banks[0].accId : "", amount: "", auto: false }); drawBanks(); recalc(); });
  const d = $("sal-delb"); if (d) d.addEventListener("click", () => { S.banks.pop(); drawBanks(); recalc(); });
}

function drawExtra() {
  $("sal-extra").innerHTML = S.extra.length ? S.extra.map((e, i) => `<div class="toolbar"><select data-xi="${i}" data-f="side"><option value="debit"${e.side === "debit" ? " selected" : ""}>借方</option><option value="credit"${e.side === "credit" ? " selected" : ""}>貸方</option></select>
    <select data-xi="${i}" data-f="acc"><option value="">科目を選ぶ</option>${accOptions(e.accId)}</select>
    <input type="text" inputmode="numeric" placeholder="金額" data-xi="${i}" data-f="amt" value="${e.amount}" style="width:110px;text-align:right">
    <input type="text" placeholder="メモ" data-xi="${i}" data-f="memo" value="${esc(e.memo)}"><button type="button" data-xdel="${i}">削除</button></div>`).join("") : `<p class="note">ありません。</p>`;
  $("sal-extra").querySelectorAll("[data-xi]").forEach((x) => x.addEventListener(x.tagName === "SELECT" ? "change" : "input", () => {
    const e = S.extra[+x.dataset.xi], f = x.dataset.f;
    if (f === "side") e.side = x.value; else if (f === "acc") e.accId = x.value; else if (f === "amt") e.amount = parseN(x.value) || ""; else e.memo = x.value;
    recalc();
  }));
  $("sal-extra").querySelectorAll("[data-xdel]").forEach((x) => x.addEventListener("click", () => { S.extra.splice(+x.dataset.xdel, 1); drawExtra(); recalc(); }));
}

// 通勤手当は「先月分の仮払交通費」を回収する。先月末の残高を台帳から計算し、直接直したときはその額を使う
function recoverBase() {
  const auto = balance25(LIST, lastDayOfPrevMonth(S.date), EXIST && EXIST.id);
  const manual = S.recover !== "" && S.recover !== undefined && S.recover !== null;
  return { auto, use: manual ? Math.max(0, Math.round(Number(S.recover) || 0)) : Math.max(0, auto), manual };
}
function current() {
  const bal = recoverBase().use;
  // 振込が1口座で、自分で書き換えていなければ、差引を自動で入れる
  const r0 = buildSalary({ ...S, bonus: S.bonus }, CFG, bal);
  if (S.banks.length === 1 && S.banks[0].auto) S.banks[0].amount = r0.net || "";
  return buildSalary(S, CFG, bal);
}

function recalc() {
  if (!$("sal")) return;
  const r = current();
  $("sal-pay").textContent = "¥" + yen(r.pay); $("sal-ded").textContent = "¥" + yen(r.ded); $("sal-net").textContent = "¥" + yen(r.net);
  const rb = recoverBase(), rc = $("sal-rec");
  if (document.activeElement !== rc) rc.value = rb.manual ? S.recover : rb.use;
  const pm = lastDayOfPrevMonth(S.date).slice(5, 7).replace(/^0/, "");
  $("sal-recnote").textContent = rb.manual ? `直接入れた額を使います（台帳では${pm}月末の残高 ¥${yen(Math.max(0, rb.auto))}）。空にすると自動に戻ります。` : `台帳から自動：${pm}月末の仮払交通費の残高です。直接直せます。回収したぶんを引いた残りが雑収入になります。`;
  const bi = $("sal-banks").querySelector('input[data-f="amt"]');
  if (bi && S.banks.length === 1 && S.banks[0].auto && document.activeElement !== bi) bi.value = S.banks[0].amount;
  const slip = parseN(S.slip);
  $("sal-chk").textContent = S.slip === "" ? "" : slip === r.net ? "✓ 明細と合っています" : `明細と ¥${yen(Math.abs(slip - r.net))} 違います`;
  $("sal-exist").textContent = EXIST ? `この月の${S.bonus ? "賞与" : "給与"}はもう記帳してあります（${EXIST.date}）。「記帳する」で作り直します。` : "";
  const nm = (id) => { const a = state.accountsById[id]; return a ? accLabel(a) : "？"; };
  const ds = r.lines.filter((l) => l.side === "debit"), cs = r.lines.filter((l) => l.side === "credit");
  const n = Math.max(ds.length, cs.length);
  let h = "";
  for (let i = 0; i < n; i++) {
    const d = ds[i], c = cs[i];
    h += `<tr><td>${d ? esc(nm(d.accId)) : ""}</td><td class="amt num">${d ? yen(d.amount) : ""}</td><td>${c ? esc(nm(c.accId)) : ""}</td><td class="amt num">${c ? yen(c.amount) : ""}</td><td class="muted">${esc((d || c || {}).memo || "")}</td></tr>`;
  }
  $("sal-prev").innerHTML = h + `<tr class="tot"><td>借方合計</td><td class="amt num">${yen(r.debit)}</td><td>貸方合計</td><td class="amt num">${yen(r.credit)}</td><td></td></tr>`;
  $("sal-bal").textContent = r.balanced ? "✓ 借方と貸方が合っています" : r.debit || r.credit ? `借方と貸方が ¥${yen(Math.abs(r.debit - r.credit))} 違います（合うまで記帳できません）` : "金額を入れてください。";
  S._r = r;
}

async function save() {
  const msg = $("sal-msg");
  showError(""); msg.textContent = "";
  const r = current();
  if (!S.date) { msg.textContent = "支給日を入れてください。"; return; }
  if (!r.balanced) { msg.textContent = "借方と貸方が合っていません。"; return; }
  if (S.extra.some((e) => e.amount && !e.accId)) { msg.textContent = "追加した行の科目を選んでください。"; return; }
  const month = monthOf(S.date);
  if (isClosed(month)) { msg.textContent = `${month}は締めてあります。月末の画面で締めを外してから記帳してください。`; return; }
  if (EXIST && !confirm("この月の記帳をいったん作り直します。よろしいですか？")) return;
  try {
    const id = salaryId(S.date, S.bonus);
    let seq = EXIST ? EXIST.seq : 0;
    if (!seq) { const list = await fetchMonthVouchers(month); seq = Math.max(list.maxSeqAll || 0, ...list.map((v) => v.seq || 0)) + 1; }
    const today = ymd(new Date());
    const v = {
      month, seq, date: S.date, entryDate: EXIST ? EXIST.entryDate || today : today, late: today > S.date,
      fieldId: CFG.fieldId || "", partyId: CFG.partyId || "", mark: "", kind: "salary", batchId: `salary-${month}`,
      lines: r.lines, createdAt: EXIST ? EXIST.createdAt || serverTimestamp() : serverTimestamp(), updatedAt: serverTimestamp()
    };
    await setDoc(doc(col("vouchers"), id), v);
    CFG.last = { vals: { ...S.vals }, banks: S.banks.map((b) => ({ accId: b.accId, amount: b.amount })) };
    await setDoc(doc(col("meta"), "salaryForm"), CFG);
    state.allVouchers = null; await loadVouchers();
    msg.textContent = `記帳しました（${S.date}・${S.bonus ? "賞与" : "給与"}）。記帳画面の${month}で見られます。`;
    LIST = await loadAllVouchers(); await checkExisting(); recalc();
  } catch (err) {
    console.error("[給与]", err);
    showError("記帳に失敗しました：" + (err.code || err.message));
  }
}

// ---- 設定（入力欄の追加・削除など） ----
function drawCfg() {
  const el = $("sal-cfg");
  const parties = state.parties.map((p) => `<option value="${p.id}"${p.id === CFG.partyId ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  el.innerHTML = `<div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>項目名</th><th>区分</th><th>科目</th><th>借方／貸方</th><th></th></tr></thead><tbody>
    ${CFG.items.map((it, i) => `<tr><td><input type="text" data-ci="${i}" data-f="label" value="${esc(it.label)}"></td>
      <td><select data-ci="${i}" data-f="group"><option value="pay"${it.group === "pay" ? " selected" : ""}>支給</option><option value="ded"${it.group === "ded" ? " selected" : ""}>控除</option></select></td>
      <td>${it.commute ? `<span class="muted">25 仮払交通費／49 雑収入（自動）</span>` : `<select data-ci="${i}" data-f="acc">${accOptions(it.accId)}</select>`}</td>
      <td>${it.commute ? "" : `<select data-ci="${i}" data-f="side"><option value="debit"${it.side === "debit" ? " selected" : ""}>借方</option><option value="credit"${it.side === "credit" ? " selected" : ""}>貸方</option></select>`}</td>
      <td>${it.commute ? "" : `<button type="button" data-cdel="${i}">削除</button>`}</td></tr>`).join("")}</tbody></table></div>
    <div class="toolbar"><button type="button" id="sal-addi">項目を追加</button>
      <label>勤務先 <select id="sal-party"><option value="">（なし）</option>${parties}</select></label>
      <label>分野 <select id="sal-field">${state.fields.map((f) => `<option value="${f.id}"${f.id === CFG.fieldId ? " selected" : ""}>${esc(f.no + " " + f.name)}</option>`).join("")}</select></label>
      <label>支給日（日） <input type="number" id="sal-payday" min="1" max="31" value="${CFG.payDay || 20}" style="width:60px"></label>
      <button type="button" class="primary" id="sal-cfgsave">設定を保存</button></div>
    <p class="note">振込先は、振込の欄の口座を選び直せます。項目を変えたら「設定を保存」を押してください。</p><p class="note" id="sal-cfgmsg"></p>`;
  el.querySelectorAll("[data-ci]").forEach((x) => x.addEventListener(x.tagName === "INPUT" ? "input" : "change", () => {
    const it = CFG.items[+x.dataset.ci], f = x.dataset.f;
    if (f === "label") it.label = x.value; else if (f === "group") it.group = x.value; else if (f === "acc") it.accId = x.value; else it.side = x.value;
  }));
  el.querySelectorAll("[data-cdel]").forEach((x) => x.addEventListener("click", () => { CFG.items.splice(+x.dataset.cdel, 1); drawCfg(); }));
  $("sal-addi").addEventListener("click", () => { CFG.items.push({ key: "x" + Date.now().toString(36), label: "新しい項目", group: "ded", accId: (accByNo(95) || {}).id || "", side: "debit" }); drawCfg(); });
  $("sal-cfgsave").addEventListener("click", async () => {
    CFG.partyId = $("sal-party").value; CFG.fieldId = $("sal-field").value; CFG.payDay = parseInt($("sal-payday").value, 10) || 20;
    CFG.banks = S.banks.map((b) => b.accId);
    try { await setDoc(doc(col("meta"), "salaryForm"), CFG); $("sal-cfgmsg").textContent = "保存しました。"; S.date = ""; renderSalary(); }
    catch (err) { $("sal-cfgmsg").textContent = "保存に失敗しました：" + (err.code || err.message); }
  });
}
