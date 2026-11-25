// 月割り償却（手順I2a）：資産の登録と予定表
import { state, col, db, loadAssets, loadVouchers, fetchMonthVouchers } from "./state.js?v=0.2I2b";
import { $, esc, yen, ymd, openModal, closeModal, showError } from "./util.js?v=0.2I2b";
import { doc, addDoc, updateDoc, writeBatch, arrayUnion, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

// ---------- 計算（画面に依存しない部分） ----------
export const monthIdx = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return (2000 + y) * 12 + mm - 1; };
export const idxMonth = (i) => String(Math.floor(i / 12)).slice(2) + "." + ((i % 12) + 1);
const daysIn = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return new Date(2000 + y, mm, 0).getDate(); };
const toApp = (v) => (v ? v.slice(2, 4) + "." + parseInt(v.slice(5, 7), 10) : ""); // "2026-11" → "26.11"
const toInput = (m) => (m ? "20" + m.split(".")[0] + "-" + String(m.split(".")[1]).padStart(2, "0") : "");

export function roundAmt(x, unit, mode) {
  if (!unit || unit <= 1) return Math.round(x);
  return (mode === "ceil" ? Math.ceil(x / unit) : Math.floor(x / unit)) * unit;
}

// 予定表を作る。返り値 { rows:[{n, month, amount}], error }
export function computeSchedule(a) {
  const amount = Math.round(a.amount || 0), start = a.startMonth;
  if (!(amount > 0)) return { rows: [], error: "取得額を入れてください。" };
  if (!/^\d{2}\.\d{1,2}$/.test(start || "")) return { rows: [], error: "開始月を入れてください。" };
  const s = monthIdx(start);
  const amts = [];
  if (a.method === "daily") {
    const per = Math.round(a.perDay || 0);
    if (!(per > 0)) return { rows: [], error: "1日あたりの額を入れてください。" };
    let rest = amount;
    for (let i = 0; rest > 0 && i < 600; i++) {
      const v = Math.min(per * daysIn(idxMonth(s + i)), rest);
      amts.push(v); rest -= v;
    }
  } else {
    const n = Math.round(a.count || 0);
    if (!(n >= 1)) return { rows: [], error: "回数を入れてください。" };
    if (a.method === "firstDiff") {
      if (n < 2) return { rows: [], error: "「初月だけ金額を変える」は2回以上にしてください。" };
      const first = Math.round(a.firstAmount || 0);
      if (first < 0 || first > amount) return { rows: [], error: "初月の額が取得額を超えています。" };
      const rest = amount - first;
      const m = a.monthly > 0 ? Math.round(a.monthly) : roundAmt(rest / (n - 1), a.roundUnit, a.roundMode);
      const last = rest - m * (n - 2);
      if (m <= 0 || last < 0) return { rows: [], error: "毎月の額が合いません（大きすぎるか、0円になります）。" };
      amts.push(first);
      for (let i = 1; i < n - 1; i++) amts.push(m);
      amts.push(last);
    } else {
      const m = a.monthly > 0 ? Math.round(a.monthly) : roundAmt(amount / n, a.roundUnit, a.roundMode);
      const adj = amount - m * (n - 1);
      if (m <= 0 || adj < 0) return { rows: [], error: "毎月の額が合いません（大きすぎるか、0円になります）。" };
      for (let i = 0; i < n; i++) amts.push(m);
      if (n === 1) amts[0] = amount;
      else if (a.remainderTo === "first") amts[0] = adj; else amts[n - 1] = adj;
    }
  }
  return { rows: amts.map((v, i) => ({ n: i + 1, month: idxMonth(s + i), amount: v })), error: "" };
}

// 各行が「済（手記帳）」「済」「未」のどれかを付ける
export function annotate(rows, a) {
  const booked = a.bookedThrough ? monthIdx(a.bookedThrough) : -1;
  const posted = new Set((a.posted || []).map((p) => p.month));
  return rows.map((r) => ({ ...r, st: monthIdx(r.month) <= booked ? "hand" : posted.has(r.month) ? "done" : "todo" }));
}

// 月割りの対象にできる資産科目：区分が「固定資産」（土地31は減らないので除く）と、23 前払費用（年払いの受け皿）
export function deprAccounts() {
  return state.accounts.filter((x) => !x.hidden && x.no !== 31 && (x.category === "固定資産" || x.no === 23)).sort((p, q) => p.no - q.no);
}

const STATUS = { active: "償却中", ended: "終了", disposed: "処分" };
const METHOD = { count: "回数で割る", firstDiff: "初月だけ金額を変える", daily: "1日あたり×日数" };

function accOptions(list, sel) {
  return list.map((a) => `<option value="${esc(a.id)}"${a.id === sel ? " selected" : ""}>${esc(a.no)} ${esc(a.name)}</option>`).join("");
}

// ---------- 画面：設定 → 月割り償却 ----------
export async function renderAssets() {
  const body = $("settings-body");
  body.innerHTML = `<p class="note">読み込み中…</p>`;
  try { await loadAssets(); } catch (err) { body.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  const list = state.assets;
  const rowsHtml = list.map((a) => {
    const sc = computeSchedule(a);
    const an = annotate(sc.rows, a);
    const done = an.filter((r) => r.st !== "todo");
    const left = a.amount - done.reduce((s, r) => s + r.amount, 0);
    const next = an.find((r) => r.st === "todo");
    return `<tr><td>${esc(a.name)}</td><td>${esc(a.acquiredDate || "")}</td><td class="amt">${yen(a.amount)}</td>
      <td>${esc(METHOD[a.method] || "")}</td><td>${esc(a.startMonth)}〜${esc(an.length ? an[an.length - 1].month : "")}</td>
      <td class="amt">${done.length}／${an.length}</td><td class="amt">${yen(left)}</td>
      <td>${next ? `${esc(next.month)}：¥${yen(next.amount)}` : "ー"}</td>
      <td>${esc(STATUS[a.status] || "")}</td>
      <td><button type="button" class="sub" data-edit="${esc(a.id)}">予定表・編集</button></td></tr>`;
  }).join("");
  body.innerHTML = `
    <div class="card" style="max-width:1100px">
      <h3>月割り償却</h3>
      <p class="note">「支払った額を毎月使っていると意識する」ための月割りです。ここに資産を登録すると、全回数の予定表が出ます（月末の下書きは次の版で付きます）。</p>
      <div class="toolbar"><button type="button" class="sub" id="as-add">＋ 資産を登録</button></div>
      ${list.length ? `<div class="tablewrap"><table class="tbl" style="min-width:0"><thead><tr><th>品名</th><th>取得日</th><th class="amt">取得額</th><th>方法</th><th>償却の期間</th><th class="amt">済／全回数</th><th class="amt">残額</th><th>次に計上</th><th>状態</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : `<p>まだ登録がありません。「＋ 資産を登録」から入れてください。</p>`}
    </div>`;
  $("as-add").addEventListener("click", () => openForm(null));
  body.querySelectorAll("button[data-edit]").forEach((b) => b.addEventListener("click", () => openForm(state.assets.find((x) => x.id === b.dataset.edit))));
}

function openForm(a) {
  const isEdit = !!a;
  const locked = isEdit && (a.posted || []).length > 0; // 仕訳に計上したあとの金額・回数の変更は、次の版（今月だけ／来月以降も）で扱う
  const assetAccs = deprAccounts(); // 固定資産の科目（土地を除く）と23 前払費用
  const expAccs = state.accounts.filter((x) => x.kind === "expense");
  const byNo = (n) => (state.accounts.find((x) => x.no === n) || {}).id || "";
  const v = a || { name: "", memo: "", acquiredDate: ymd(new Date()), amount: "", assetAccId: byNo(33), expenseAccId: byNo(74),
    method: "count", count: 36, monthly: "", firstAmount: "", perDay: "", roundUnit: 1, roundMode: "floor", remainderTo: "last",
    startMonth: "", bookedThrough: "", status: "active" };
  const dis = locked ? " disabled" : "";
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
    <h2>${isEdit ? "償却資産の予定表・編集" : "償却資産を登録"}</h2>
    ${locked ? `<p class="note">仕訳に計上した月があるため、金額・回数・方法は変えられません（変更は「今月だけ／来月以降も」の機能で行います）。品名・メモ・状態は直せます。</p>` : ""}
    <div class="fgrid">
      <label>品名<input id="as-name" value="${esc(v.name)}"></label>
      <label>メモ<input id="as-memo" value="${esc(v.memo || "")}"></label>
      <label>取得日<input type="date" id="as-date" value="${esc(v.acquiredDate || "")}"${dis}></label>
      <label>取得額（円）<input id="as-amount" inputmode="numeric" value="${esc(v.amount)}"${dis}></label>
      <label>資産科目<select id="as-acc"${dis}>${accOptions(assetAccs, v.assetAccId)}</select></label>
      <label>償却先の経費科目<select id="as-exp"${dis}>${accOptions(expAccs, v.expenseAccId)}</select></label>
      <label>償却の方法<select id="as-method"${dis}>${Object.entries(METHOD).map(([k, t]) => `<option value="${k}"${k === v.method ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>開始月<input type="month" id="as-start" value="${esc(toInput(v.startMonth))}"${dis}></label>
      <label class="m-count m-firstDiff">回数<input id="as-count" inputmode="numeric" value="${esc(v.count)}"${dis}></label>
      <label class="m-count m-firstDiff">毎月の額（空欄＝自動）<input id="as-monthly" inputmode="numeric" value="${esc(v.monthly || "")}"${dis}></label>
      <label class="m-firstDiff">初月の額<input id="as-first" inputmode="numeric" value="${esc(v.firstAmount || "")}"${dis}></label>
      <label class="m-daily">1日あたりの額<input id="as-perday" inputmode="numeric" value="${esc(v.perDay || "")}"${dis}></label>
      <label class="m-count m-firstDiff">自動のときの丸め<select id="as-unit"${dis}>${[1, 10, 50, 100].map((u) => `<option value="${u}"${u === v.roundUnit ? " selected" : ""}>${u === 1 ? "丸めない" : u + "円単位"}</option>`).join("")}</select></label>
      <label class="m-count m-firstDiff">切り上げ／切り捨て<select id="as-rmode"${dis}><option value="floor"${v.roundMode === "floor" ? " selected" : ""}>切り捨て</option><option value="ceil"${v.roundMode === "ceil" ? " selected" : ""}>切り上げ</option></select></label>
      <label class="m-count">端数を寄せる月<select id="as-rem"${dis}><option value="last"${v.remainderTo === "last" ? " selected" : ""}>最終月</option><option value="first"${v.remainderTo === "first" ? " selected" : ""}>初月</option></select></label>
      <label>手で記帳済みの月まで（なければ空欄）<input type="month" id="as-booked" value="${esc(toInput(v.bookedThrough))}"${isEdit && locked ? " disabled" : ""}></label>
      <label>状態<select id="as-status">${Object.entries(STATUS).map(([k, t]) => `<option value="${k}"${k === v.status ? " selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
    <p id="as-msg" class="note"></p>
    <div class="tablewrap" style="max-height:300px;overflow:auto"><table class="tbl" style="min-width:0"><thead><tr><th>回</th><th>月度</th><th class="amt">金額</th><th class="amt">累計</th><th class="amt">残り</th><th>状態</th></tr></thead><tbody id="as-sched"></tbody></table></div>
    <div class="actions"><button type="button" class="sub" id="as-cancel">閉じる</button><button type="button" class="primary" id="as-save">${isEdit ? "保存" : "登録する"}</button></div>
  </div>`);
  const g = (id) => $(id).value;
  const num = (id) => { const t = g(id).replace(/[，,\s]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)); return t === "" ? 0 : Number(t); };
  const read = () => ({
    name: g("as-name").trim(), memo: g("as-memo").trim(), acquiredDate: g("as-date"), amount: num("as-amount"),
    assetAccId: g("as-acc"), expenseAccId: g("as-exp"), method: g("as-method"),
    startMonth: toApp(g("as-start")) || (g("as-date") ? toApp(g("as-date").slice(0, 7)) : ""),
    count: num("as-count"), monthly: num("as-monthly"), firstAmount: num("as-first"), perDay: num("as-perday"),
    roundUnit: Number(g("as-unit")), roundMode: g("as-rmode"), remainderTo: g("as-rem"),
    bookedThrough: toApp(g("as-booked")), status: g("as-status"), posted: a ? a.posted || [] : []
  });
  let cur = null;
  const redraw = () => {
    const m = g("as-method");
    document.querySelectorAll(".m-count,.m-firstDiff,.m-daily").forEach((el) => { el.hidden = true; });
    document.querySelectorAll(".m-" + m).forEach((el) => { el.hidden = false; });
    cur = read();
    const sc = computeSchedule(cur);
    $("as-msg").textContent = sc.error;
    if (sc.error) { $("as-sched").innerHTML = ""; return; }
    const an = annotate(sc.rows, cur);
    let cum = 0;
    const total = sc.rows.reduce((s, r) => s + r.amount, 0);
    $("as-sched").innerHTML = an.map((r) => { cum += r.amount;
      return `<tr><td>${r.n}</td><td>${esc(r.month)}</td><td class="amt">${yen(r.amount)}</td><td class="amt">${yen(cum)}</td><td class="amt">${yen(cur.amount - cum)}</td><td>${r.st === "hand" ? "済（手記帳）" : r.st === "done" ? "済" : "未"}</td></tr>`; }).join("");
    $("as-msg").textContent = `全${an.length}回　合計 ¥${yen(total)} ${total === cur.amount ? "＝ 取得額 ✓" : "⚠ 取得額と合いません"}`;
  };
  document.querySelector("#modal .fgrid").addEventListener("input", redraw);
  document.querySelector("#modal .fgrid").addEventListener("change", redraw);
  redraw();
  $("as-cancel").addEventListener("click", closeModal);
  $("as-save").addEventListener("click", async () => {
    cur = read();
    if (!cur.name) return ($("as-msg").textContent = "品名を入れてください。");
    const sc = computeSchedule(cur);
    if (sc.error) return ($("as-msg").textContent = sc.error);
    if (sc.rows.reduce((s, r) => s + r.amount, 0) !== cur.amount) return ($("as-msg").textContent = "予定表の合計が取得額と合いません。");
    if (!cur.assetAccId || !cur.expenseAccId) return ($("as-msg").textContent = "科目を選んでください。");
    $("as-save").disabled = true;
    try {
      const data = { ...cur, updatedAt: serverTimestamp() };
      if (isEdit) {
        const keep = locked ? { name: cur.name, memo: cur.memo, status: cur.status, updatedAt: serverTimestamp() } : data;
        await updateDoc(doc(col("assets"), a.id), keep);
      } else await addDoc(col("assets"), { ...data, posted: [], createdAt: serverTimestamp() });
      closeModal();
      renderAssets();
    } catch (err) {
      console.error("[月割り償却]", err);
      $("as-save").disabled = false;
      $("as-msg").textContent = "保存に失敗しました：" + (err.code || err.message);
    }
  });
}


// ---------- 月末の下書き（I2b） ----------
const lastDayOf = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return `${2000 + y}-${String(mm).padStart(2, "0")}-${String(daysIn(m)).padStart(2, "0")}`; };

// その月の最終日以降で、まだ計上していない償却（償却中の資産だけ）。古い月から順に並べる
export function pendingDrafts(today = ymd(new Date())) {
  const out = [];
  for (const a of state.assets || []) {
    if (a.status !== "active") continue;
    const sc = computeSchedule(a);
    if (sc.error) continue;
    const an = annotate(sc.rows, a);
    an.forEach((r) => {
      if (r.st === "todo" && today >= lastDayOf(r.month)) out.push({ asset: a, month: r.month, n: r.n, total: an.length, amount: r.amount, date: lastDayOf(r.month) });
    });
  }
  return out.sort((p, q) => monthIdx(p.month) - monthIdx(q.month) || (p.asset.name < q.asset.name ? -1 : 1));
}

// 記帳画面の上のお知らせ
export function renderDeprBanner(el, onDone) {
  if (!el) return;
  const d = pendingDrafts();
  if (!d.length) { el.hidden = true; el.innerHTML = ""; return; }
  const total = d.reduce((s, x) => s + x.amount, 0);
  el.hidden = false;
  el.innerHTML = `<span>月割り償却の<strong>未計上が${d.length}件</strong>（計 ¥${yen(total)}）あります。</span><button type="button" class="primary" id="dp-open">確認する</button>`;
  $("dp-open").addEventListener("click", () => openDraftDialog(onDone));
}

function openDraftDialog(onDone) {
  const d = pendingDrafts();
  if (!d.length) return;
  const accName = (id) => (state.accountsById[id] || {}).name || "?";
  openModal(`<div class="dialog wide" role="dialog" aria-modal="true">
    <h2>月割り償却の下書き（確認して登録）</h2>
    <p class="note">チェックを入れた分を、その月の最終日付の仕訳として登録します。登録後は、ふつうの仕訳と同じように記帳画面から直せます。</p>
    <div class="tablewrap" style="max-height:320px;overflow:auto"><table class="tbl" style="min-width:0"><thead><tr><th></th><th>月度</th><th>日付</th><th>品名</th><th>回</th><th>借方</th><th>貸方</th><th class="amt">金額</th></tr></thead><tbody>
    ${d.map((x, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td>${esc(x.month)}</td><td>${esc(x.date)}</td><td>${esc(x.asset.name)}</td><td>${x.n}／${x.total}</td><td>${esc(accName(x.asset.expenseAccId))}</td><td>${esc(accName(x.asset.assetAccId))}</td><td class="amt">${yen(x.amount)}</td></tr>`).join("")}
    </tbody></table></div>
    <p id="dp-msg" class="note"></p>
    <div class="actions"><button type="button" class="sub" id="dp-cancel">あとで</button><button type="button" class="primary" id="dp-ok">選んだ分を登録</button></div></div>`);
  $("dp-cancel").addEventListener("click", closeModal);
  $("dp-ok").addEventListener("click", async () => {
    const picks = [...document.querySelectorAll("#modal input[data-i]")].filter((c) => c.checked).map((c) => d[Number(c.dataset.i)]);
    if (!picks.length) return ($("dp-msg").textContent = "登録する行を選んでください。");
    $("dp-ok").disabled = true; $("dp-cancel").disabled = true;
    try {
      await postDrafts(picks, (k) => { $("dp-msg").textContent = `登録しています… ${k}／${picks.length}`; });
      closeModal();
      if (onDone) await onDone();
    } catch (err) {
      console.error("[月割り償却] 登録失敗", err);
      $("dp-msg").textContent = "失敗しました：" + (err.code || err.message) + "（途中まで登録されている可能性があります。画面を開き直して確認してください）";
      $("dp-cancel").disabled = false; $("dp-cancel").textContent = "閉じる";
    }
  });
}

// 下書きを仕訳にする。仕訳のidは「資産×月」で決まる固定の値にして、同じ月を二重に作らない
export async function postDrafts(picks, onStep) {
  const nextSeq = {};
  let k = 0;
  for (const p of picks) {
    if (!(p.month in nextSeq)) {
      const list = await fetchMonthVouchers(p.month);
      nextSeq[p.month] = Math.max(list.maxSeqAll || 0, ...list.map((v) => v.seq || 0)) + 1;
    }
    const a = p.asset;
    const id = `depr_${a.id}_${p.month.replace(".", "_")}`;
    const today = ymd(new Date());
    const biz = (state.accountsById[a.expenseAccId] || {}).biz || "life";
    const memo = `${a.name} 月割り償却 ${p.n}/${p.total}`;
    const voucher = {
      month: p.month, seq: nextSeq[p.month]++, date: p.date, entryDate: today, late: today > p.date,
      fieldId: "", partyId: "", mark: "", auto: "depreciation", assetId: a.id,
      lines: [
        { side: "debit", accId: a.expenseAccId, amount: p.amount, tax: 0, memo, tags: [], biz },
        { side: "credit", accId: a.assetAccId, amount: p.amount, tax: 0, memo, tags: [], biz }
      ],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    batch.set(doc(col("vouchers"), id), voucher);
    const upd = { posted: arrayUnion({ month: p.month, voucherId: id }), updatedAt: serverTimestamp() };
    batch.update(doc(col("assets"), a.id), upd);
    await batch.commit();
    a.posted = [...(a.posted || []), { month: p.month, voucherId: id }]; // 画面側の控えも更新
    k++; if (onStep) onStep(k);
  }
  // すべて計上し終わった資産は「終了」にする
  for (const a of new Set(picks.map((p) => p.asset))) {
    const sc = computeSchedule(a);
    if (!annotate(sc.rows, a).some((r) => r.st === "todo") && a.status === "active") {
      await updateDoc(doc(col("assets"), a.id), { status: "ended", updatedAt: serverTimestamp() });
      a.status = "ended";
    }
  }
  state.allVouchers = null;
  await loadVouchers();
}
