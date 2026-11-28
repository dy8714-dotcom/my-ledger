// 月末（手順I3）：金融資産の評価替え
import { state, col, db, loadAllVouchers, loadVouchers, fetchMonthVouchers, loadClosings, isClosed, loadAssets } from "./state.js?v=0.2I11e";
import { pendingDrafts } from "./assets.js?v=0.2I11e";
import { monthStatus } from "./recurring.js?v=0.2I11e";
import { downloadFullBackup, makeCopy, saveBackupToDrive } from "./backup.js?v=0.2I11e";
import { $, esc, yen, ymd, hk, shiftMonth, monthOf, WD, showError } from "./util.js?v=0.2I11e";
import { doc, getDocs, writeBatch, setDoc, deleteField, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { presetSalary } from "./salary.js?v=0.2I11e";

const EVAL_NOS = [26, 27, 28, 29, 30]; // 評価替えの対象（金融資産）
// 評価益・評価損の科目：仮想通貨＝80/81、そのほか（株）＝82/83
const pairOf = (no) => (no === 26 ? [80, 81] : [82, 83]);
const accByNo = (no) => state.accounts.find((a) => a.no === no);

const lastDayOf = (m) => {
  const [y, mm] = m.split(".").map((x) => parseInt(x, 10));
  return `${2000 + y}-${String(mm).padStart(2, "0")}-${String(new Date(2000 + y, mm, 0).getDate()).padStart(2, "0")}`;
};
const evalId = (accId, month) => `eval_${accId}_${month.replace(".", "_")}`;

// 指定した日までの、その科目の帳簿残高（資産なので借方−貸方）。除く仕訳（その月の評価替え）は含めない
export function balanceAt(vouchers, accId, date, excludeId) {
  let b = 0;
  vouchers.forEach((v) => {
    if (v.id === excludeId || v.date > date) return;
    v.lines.forEach((l) => { if (l.accId === accId) b += l.side === "debit" ? l.amount : -l.amount; });
  });
  return b;
}

// 時価を入れた科目ごとに、作る仕訳の中身を決める
export function planEval(row, month, date) {
  const [gainNo, lossNo] = pairOf(row.acc.no);
  const diff = row.value - row.book;
  if (diff === 0) return { diff, voucher: null };
  const gain = diff > 0;
  const other = accByNo(gain ? gainNo : lossNo);
  const memo = `評価替え ${row.acc.no}${row.acc.name} 時価¥${yen(row.value)}`;
  const mk = (side, accId) => ({ side, accId, amount: Math.abs(diff), tax: 0, memo, tags: [], biz: "life" });
  return {
    diff,
    voucher: { month, date, lines: gain ? [mk("debit", row.acc.id), mk("credit", other.id)] : [mk("debit", other.id), mk("credit", row.acc.id)] }
  };
}

async function loadValuations() {
  const snap = await getDocs(col("valuations"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 「月末」タブ：月次締め／評価替えの2つ
export async function renderMonthEnd() {
  const me = (state.me = state.me || { month: state.month, date: "" });
  me.sub = me.sub || "close";
  $("view").innerHTML = `<div class="subtabs">
    <button type="button" data-sub="close" class="${me.sub === "close" ? "active" : ""}">月次締め</button>
    <button type="button" data-sub="eval" class="${me.sub === "eval" ? "active" : ""}">評価替え</button></div><div id="me-body"></div>`;
  document.querySelector("#view .subtabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sub]");
    if (!b) return;
    me.sub = b.dataset.sub; renderMonthEnd();
  });
  if (me.sub === "close") return renderClose($("me-body"));
  return renderEval($("me-body"));
}

async function renderEval(view) {
  const me = state.me;
  const month = me.month;
  const monthEnd = lastDayOf(month);
  if (!me.date || monthOf(me.date) !== month) me.date = monthEnd;
  view.innerHTML = `<p class="note">読み込み中…</p>`;
  let all, vals;
  try { all = await loadAllVouchers(); vals = await loadValuations(); }
  catch (err) { view.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  const live = new Map(all.map((v) => [v.id, v]));
  const accs = EVAL_NOS.map(accByNo).filter((a) => a && !a.hidden);
  const rows = accs.map((acc) => {
    const ex = evalId(acc.id, month);
    const rec = vals.find((x) => x.id === `${acc.id}_${me.date}`);
    return { acc, book: balanceAt(all, acc.id, me.date, ex), exId: ex, existing: live.get(ex), rec };
  });
  const wd = new Date(me.date + "T00:00:00").getDay();
  const isEnd = me.date === monthEnd;
  view.innerHTML = `
    <div class="monthbar">
      <button type="button" class="navbtn" id="me-prev" aria-label="前の月度">◀</button>
      <h2>${esc(month)}月度の評価替え</h2>
      <button type="button" class="navbtn" id="me-next" aria-label="次の月度">▶</button>
    </div>
    <section class="panel">
      <h3><span class="bar"></span>金融資産の評価替え</h3>
      <p class="note">証券会社・取引所のアプリで見た評価額（時価）を入れます。帳簿の残高との差額を、評価益・評価損の仕訳にします。</p>
      <div class="toolbar">
        <label class="note" for="me-date">評価の日付</label>
        <input type="date" id="me-date" value="${esc(me.date)}" min="${esc(monthEnd.slice(0, 8) + "01")}" max="${esc(monthEnd)}">
        <span class="note">（${WD[wd]}）${isEnd ? "月末です：差額を仕訳にします" : "月の途中です：時価を記録するだけで、仕訳は作りません"}</span>
        <button type="button" class="sub" id="me-end">月末にする</button>
      </div>
      <div class="tablewrap"><table class="tbl" style="min-width:0"><thead><tr><th>科目</th><th class="amt">帳簿の残高</th><th class="amt">時価（入力）</th><th class="amt">差額</th><th>作られる仕訳</th><th>いまの状態</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-i="${i}"><td>${esc(r.acc.no)} ${esc(hk(r.acc.name))}</td><td class="amt">${yen(r.book)}</td>
        <td class="amt"><input class="me-val" data-i="${i}" inputmode="numeric" style="width:120px;text-align:right" value="${r.rec ? esc(r.rec.value) : ""}" placeholder="評価額"></td>
        <td class="amt me-diff"></td><td class="me-plan"></td>
        <td class="note">${r.existing ? `評価替え済み（${esc(r.existing.month)}-${esc(r.existing.seq)}）` : r.rec ? `記録済み ¥${yen(r.rec.value)}` : "未入力"}</td></tr>`).join("")}
      </tbody></table></div>
      <p id="me-msg" class="note"></p>
      <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="me-go">${isEnd ? "評価替えを登録" : "記録だけ保存"}</button></div>
    </section>`;
  $("me-prev").addEventListener("click", () => { me.month = shiftMonth(month, -1); me.date = ""; renderMonthEnd(); });
  $("me-next").addEventListener("click", () => { me.month = shiftMonth(month, 1); me.date = ""; renderMonthEnd(); });
  $("me-end").addEventListener("click", () => { me.date = monthEnd; renderMonthEnd(); });
  $("me-date").addEventListener("change", (e) => { if (e.target.value && monthOf(e.target.value) === month) { me.date = e.target.value; renderMonthEnd(); } });
  const val = (i) => { const t = document.querySelectorAll(".me-val")[i].value.replace(/[，,\s]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)); return t === "" ? null : (/^\d+$/.test(t) ? Number(t) : NaN); };
  const redraw = () => {
    rows.forEach((r, i) => {
      const tr = document.querySelector(`tr[data-i="${i}"]`);
      const v = val(i);
      const diffEl = tr.querySelector(".me-diff"), planEl = tr.querySelector(".me-plan");
      if (v === null) { diffEl.textContent = ""; planEl.textContent = ""; return; }
      if (Number.isNaN(v)) { diffEl.textContent = "?"; planEl.textContent = "数字で入れてください"; return; }
      const p = planEval({ ...r, value: v }, month, me.date);
      diffEl.textContent = (p.diff > 0 ? "+" : p.diff < 0 ? "−" : "") + yen(Math.abs(p.diff));
      diffEl.className = "amt me-diff " + (p.diff > 0 ? "inc" : "");
      planEl.textContent = !isEnd ? "（記録のみ）" : p.voucher ? `${state.accountsById[p.voucher.lines[0].accId].no} ${hk(state.accountsById[p.voucher.lines[0].accId].name)} ／ ${state.accountsById[p.voucher.lines[1].accId].no} ${hk(state.accountsById[p.voucher.lines[1].accId].name)}　¥${yen(Math.abs(p.diff))}` : "差額なし（仕訳なし）";
    });
  };
  document.querySelector(".tablewrap").addEventListener("input", redraw);
  redraw();
  $("me-go").addEventListener("click", async () => {
    const todo = [];
    for (let i = 0; i < rows.length; i++) {
      const v = val(i);
      if (v === null) continue;
      if (Number.isNaN(v)) return ($("me-msg").textContent = "時価は数字で入れてください。");
      todo.push({ ...rows[i], value: v });
    }
    if (!todo.length) return ($("me-msg").textContent = "時価を入れた科目がありません。");
    if (isClosed(month) && !window.confirm(`${month}月度は締め済みです。評価替えを登録すると、締めたときの残高とずれます。続けますか？`)) return;
    $("me-go").disabled = true;
    try {
      const made = await postEval(todo, month, me.date, isEnd, live);
      state.me.note = made;
      await renderMonthEnd();
      $("me-msg").textContent = made;
    } catch (err) {
      console.error("[評価替え]", err);
      $("me-go").disabled = false;
      $("me-msg").textContent = "失敗しました：" + (err.code || err.message);
    }
  });
}

// 評価替えの登録。仕訳のidは「科目×月」で固定なので、同じ月にやり直しても二重にならない
export async function postEval(todo, month, date, isEnd, live) {
  const batch = writeBatch(db);
  const msgs = [];
  let seqBase = null;
  const today = ymd(new Date());
  for (const r of todo) {
    let voucherId = null;
    if (isEnd) {
      const p = planEval(r, month, date);
      const ref = doc(col("vouchers"), r.exId);
      if (p.voucher) {
        let seq;
        if (r.existing) seq = r.existing.seq;
        else {
          if (seqBase === null) { const list = await fetchMonthVouchers(month); seqBase = Math.max(list.maxSeqAll || 0, ...list.map((v) => v.seq || 0)); }
          seq = ++seqBase;
        }
        batch.set(ref, {
          month, seq, date, entryDate: today, late: today > date, fieldId: "", partyId: "", mark: "", auto: "valuation", kind: "valuation", batchId: `val-${month}`, accId: r.acc.id,
          lines: p.voucher.lines, deleted: deleteField(), deletedAt: deleteField(), updatedAt: serverTimestamp(), ...(r.existing ? {} : { createdAt: serverTimestamp() })
        }, { merge: true });
        voucherId = r.exId;
        msgs.push(`${r.acc.no}${r.acc.name}：${p.diff > 0 ? "評価益" : "評価損"} ¥${yen(Math.abs(p.diff))}（${month}-${seq}）`);
      } else if (r.existing) {
        batch.set(ref, { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() }, { merge: true }); // 差額がなくなったら前回の評価替えは取り消す（30日は戻せる）
        msgs.push(`${r.acc.no}${r.acc.name}：差額なし（前回の評価替えを取り消し）`);
      } else msgs.push(`${r.acc.no}${r.acc.name}：差額なし`);
    } else msgs.push(`${r.acc.no}${r.acc.name}：時価 ¥${yen(r.value)} を記録`);
    batch.set(doc(col("valuations"), `${r.acc.id}_${date}`), { accId: r.acc.id, date, month, value: r.value, voucherId, updatedAt: serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  state.allVouchers = null;
  await loadVouchers();
  return (isEnd ? "登録しました。" : "記録しました。") + msgs.join("　");
}

// ---------- 月次締め（I4） ----------
// 指定した日までの、全科目の残高（借方−貸方）
export function balancesAt(vouchers, date) {
  const b = {};
  vouchers.forEach((v) => {
    if (v.date > date) return;
    v.lines.forEach((l) => { b[l.accId] = (b[l.accId] || 0) + (l.side === "debit" ? l.amount : -l.amount); });
  });
  Object.keys(b).forEach((k) => { if (b[k] === 0) delete b[k]; });
  return b;
}
// 締めた時の控えと、いまの計算結果の違い
export function diffBalances(saved, now) {
  const out = [];
  new Set([...Object.keys(saved || {}), ...Object.keys(now)]).forEach((id) => {
    const a = (saved || {})[id] || 0, b = now[id] || 0;
    if (a !== b) out.push({ accId: id, saved: a, now: b });
  });
  return out.sort((p, q) => ((state.accountsById[p.accId] || {}).no || 999) - ((state.accountsById[q.accId] || {}).no || 999));
}
// 締め済みの月に記帳・修正・削除するときの確認（保存の前に出す）。返り値：true＝続ける
export function askClosedConfirm(months, anchorEl) {
  const closed = [...new Set(months)].filter(isClosed);
  if (!closed.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "askbox";
    box.innerHTML = `<p><strong>${closed.map(esc).join("・")}月度は「締め済み」です。</strong>この月に記帳・修正・削除すると、締めたときの残高とずれます。</p>
      <p class="note">続けた場合は、「月末」タブの月次締めに「締めた後に変わった」と表示されます。</p>
      <div class="actions"><button type="button" class="sub" data-c="no">やめる</button><button type="button" class="primary" data-c="yes">それでも続ける</button></div>`;
    anchorEl.insertAdjacentElement("afterend", box);
    box.addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (!b) return; box.remove(); resolve(b.dataset.c === "yes"); });
  });
}

async function renderClose(view) {
  const me = state.me, month = me.month, end = lastDayOf(month);
  view.innerHTML = `<p class="note">読み込み中…</p>`;
  let all, vals;
  try { all = await loadAllVouchers(); vals = await loadValuations(); await loadClosings(); await loadAssets(); }
  catch (err) { view.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  const closing = (state.closings || []).find((c) => c.month === month);
  const closed = !!closing && closing.status === "closed";
  const upto = all.filter((v) => v.date <= end);
  let dr = 0, cr = 0, bad = 0;
  upto.forEach((v) => {
    const d = v.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0), c = v.lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
    dr += d; cr += c; if (d !== c) bad++;
  });
  const now = balancesAt(all, end);
  const drafts = pendingDrafts(end);
  const evalMiss = EVAL_NOS.map(accByNo).filter((a) => a && !a.hidden && (now[a.id] || 0) !== 0)
    .filter((a) => !vals.some((x) => x.id === `${a.id}_${end}`) && !all.some((v) => v.id === evalId(a.id, month)));
  const manual = (me.manual = me.manual && me.manual.month === month ? me.manual : { month, recurring: false, points: false });
  const okBal = dr === cr && bad === 0;
  // 現金・預金（電子マネーなど）が月末にマイナスのまま残っていないか
  const negCash = state.accounts.filter((a) => a.kind === "asset" && a.category === "現金・預金" && (now[a.id] || 0) < 0);
  const okNeg = negCash.length === 0;
  // 定期支払：その月度に記帳すべきものが、すべて記帳済みか（自動で調べる）
  const recSt = monthStatus(state.recurring || [], month, all.filter((v) => v.month === month), "9999-12-31");
  const recTodo = recSt.filter((s) => !s.done);
  const okRec = recTodo.length === 0;
  // 給与：その月度に、給与の入力画面で作った仕訳（種別：給与）があるか（賞与は数えない）
  const salV = all.find((v) => v.month === month && v.kind === "salary" && !v.deleted && !/^bonus_/.test(v.id || ""));
  const okSal = !!salV;
  const okDep = drafts.length === 0, okEval = evalMiss.length === 0;
  const mark = (ok) => (ok ? `<span class="ok">✓</span>` : `<span class="ng">⚠</span>`);
  const changed = closed ? diffBalances(closing.balances, now) : [];
  const ts = (x) => (x && x.toDate ? x.toDate() : x ? new Date(x) : null);
  view.innerHTML = `
    <div class="monthbar">
      <button type="button" class="navbtn" id="cl-prev" aria-label="前の月度">◀</button>
      <h2>${esc(month)}月度の月次締め ${closed ? `<span class="chip biz">締め済み</span>` : ""}</h2>
      <button type="button" class="navbtn" id="cl-next" aria-label="次の月度">▶</button>
    </div>
    <section class="panel">
      <h3><span class="bar"></span>締めのチェックリスト（${esc(month)}月度：${esc(end)}まで）</h3>
      <div class="tablewrap"><table class="tbl" style="min-width:0"><tbody>
        <tr><td style="width:40px">${mark(okRec)}</td><td>定期支払（☆★◇◆）がすべて記帳されている</td><td class="note">${!recSt.length ? "この月度の定期支払はありません" : okRec ? `${recSt.length}件すべて記帳済み` : `未記帳が${recTodo.length}件：${recTodo.map((x) => esc((x.rec.mark || "") + x.rec.name)).join("、")}　<button type="button" class="sub" id="cl-rec-go">記帳画面で確認する</button>`}</td></tr>
        <tr><td>${mark(okSal)}</td><td>給与を入力して、仕訳を作った</td><td class="note">${okSal ? `記帳済み（${esc(salV.date)}）` : `まだありません。<button type="button" class="sub" id="cl-sal-go">給与タブで入力する</button>`}</td></tr>
        <tr><td>${mark(okDep)}</td><td>月割り償却の仕訳を登録した</td><td class="note">${okDep ? "未計上なし" : `未計上が${drafts.length}件あります（記帳画面の上の「確認する」から登録）`}</td></tr>
        <tr><td>${mark(okEval)}</td><td>金融資産の評価替えをした</td><td class="note">${okEval ? "残高のある科目はすべて入力済み" : `未入力：${evalMiss.map((a) => esc(a.no + a.name)).join("、")}（「評価替え」タブ）`}</td></tr>
        <tr><td><input type="checkbox" id="cl-m2" ${manual.points ? "checked" : ""} ${closed ? "disabled" : ""}></td><td>ポイントの残高合わせ（任意）</td><td class="note">残高合わせの機能はまだないので、必要なら手で記帳してチェックします</td></tr>
        <tr><td>${mark(okNeg)}</td><td>現金・預金・電子マネーがマイナスになっていない</td><td class="note">${okNeg ? "マイナスの科目なし" : `月末にマイナス：${negCash.map((a) => esc(a.no + a.name) + " ¥" + yen(now[a.id])).join("、")}（チャージなどの記帳漏れがないか確認）`}</td></tr>
        <tr><td>${mark(okBal)}</td><td>貸借が一致している</td><td class="note">借方計 ¥${yen(dr)}／貸方計 ¥${yen(cr)}${bad ? `（借方と貸方が合わない仕訳が${bad}件）` : ""}</td></tr>
      </tbody></table></div>
      ${closed && me.justClosed === month ? `<div class="askbox" id="cl-bk"><p><strong>${esc(month)}月度を締めました。</strong>${esc(me.copyNote || "")}いまの全データをバックアップしますか？（おすすめ：Googleドライブ）</p>
        <div class="actions"><button type="button" class="sub" id="cl-bk-no">あとで</button><button type="button" class="primary" id="cl-bk-drive">Googleドライブに保存</button><button type="button" class="sub" id="cl-bk-yes">PCに保存</button></div><p class="note" id="cl-bk-msg"></p></div>` : ""}
      ${closed ? `
        <p class="note">${esc(month)}月度は ${ts(closing.closedAt) ? esc(ts(closing.closedAt).toLocaleString("ja-JP")) : ""} に締めました（締めた時の残高の控えを保存済み）。</p>
        ${changed.length ? `<div class="askbox"><p><strong>⚠ 締めた後に変わりました。</strong>締めた時の控えと、いまの計算結果がずれている科目があります。</p>
          <table class="tbl" style="min-width:0"><thead><tr><th>科目</th><th class="amt">締めた時</th><th class="amt">いま</th><th class="amt">差</th></tr></thead><tbody>
          ${changed.map((c) => { const a = state.accountsById[c.accId] || {}; return `<tr><td>${esc(a.no)} ${esc(hk(a.name || c.accId))}</td><td class="amt">${yen(c.saved)}</td><td class="amt">${yen(c.now)}</td><td class="amt">${c.now - c.saved > 0 ? "+" : "−"}${yen(Math.abs(c.now - c.saved))}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="ok">✓ 締めた時の残高と、いまの計算結果は一致しています。</p>`}
        <div class="actions" style="justify-content:flex-start"><button type="button" class="danger" id="cl-reopen">締めを解除する</button></div>`
      : `<p id="cl-msg" class="note">${okRec && okSal && okDep && okEval && okBal ? "すべてそろっています。" : "そろっていない項目があります。確認してから締めてください。"}</p>
        <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="cl-close">${esc(month)}月度を締める</button></div>
        <p class="note">締めると、その月の全科目の残高を「控え」として保存します。締めたあとにその月へ記帳すると確認画面が出て、控えとずれると「締めた後に変わった」と表示します。</p>`}
    </section>
    ${closedListHtml(all)}`;
  $("cl-prev").addEventListener("click", () => { me.month = shiftMonth(month, -1); me.date = ""; renderMonthEnd(); });
  $("cl-next").addEventListener("click", () => { me.month = shiftMonth(month, 1); me.date = ""; renderMonthEnd(); });
  if ($("cl-bk")) {
    $("cl-bk-no").addEventListener("click", () => { me.justClosed = null; $("cl-bk").remove(); });
    $("cl-bk-drive").addEventListener("click", async () => {
      $("cl-bk-drive").disabled = true; $("cl-bk-yes").disabled = true; $("cl-bk-msg").textContent = "Googleの許可の画面を確認してください…";
      try {
        const r = await saveBackupToDrive(`my-ledger-backup-月次締め-${month}`);
        me.justClosed = null;
        $("cl-bk-msg").innerHTML = `ドライブに保存しました（${esc(r.name)}）。<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">ドライブのフォルダを開く</a>`;
        $("cl-bk-drive").hidden = true; $("cl-bk-yes").hidden = true; $("cl-bk-no").textContent = "閉じる";
      } catch (err) { console.error(err); $("cl-bk-drive").disabled = false; $("cl-bk-yes").disabled = false; $("cl-bk-msg").textContent = "失敗しました：" + err.message; }
    });
    $("cl-bk-yes").addEventListener("click", async () => {
      $("cl-bk-yes").disabled = true; $("cl-bk-msg").textContent = "保存しています…";
      try {
        await downloadFullBackup(`my-ledger-backup-月次締め-${month}`);
        me.justClosed = null;
        $("cl-bk-msg").textContent = "バックアップを保存しました（ダウンロードしたファイルを確認してください）。";
        $("cl-bk-yes").hidden = true; $("cl-bk-no").textContent = "閉じる";
      } catch (err) { console.error(err); $("cl-bk-yes").disabled = false; $("cl-bk-msg").textContent = "失敗しました：" + (err.code || err.message); }
    });
  }
  if ($("cl-rec-go")) $("cl-rec-go").addEventListener("click", async () => { state.month = month; try { await loadVouchers(); } catch (err) { console.error(err); } document.querySelector('#nav [data-tab="entry"]').click(); });
  if ($("cl-sal-go")) $("cl-sal-go").addEventListener("click", () => { presetSalary(month); document.querySelector('#nav [data-tab="salary"]').click(); });
  if ($("cl-m2")) $("cl-m2").addEventListener("change", (e) => { manual.points = e.target.checked; });
  if ($("cl-close")) $("cl-close").addEventListener("click", async () => {
    const miss = [];
    if (!okRec) miss.push("定期支払の記帳");
    if (!okSal) miss.push("給与の記帳");
    if (!okDep) miss.push("月割り償却");
    if (!okEval) miss.push("評価替え");
    if (!okNeg) miss.push("現金・預金のマイナス");
    if (!okBal) miss.push("貸借の一致");
    if (miss.length && !window.confirm(`次の項目がそろっていません：${miss.join("、")}\nそれでも締めますか？`)) return;
    $("cl-close").disabled = true;
    try {
      await closeMonth(month, now, upto.length, { recurring: okRec, points: manual.points });
      me.justClosed = month; // 締めた直後は、バックアップの案内を出す
      try { await makeCopy(`月次締め ${month}`); me.copyNote = "Firestore内に控えを自動で作りました。"; }
      catch (err) { console.error("[控え]", err); me.copyNote = "Firestore内の控えは作れませんでした（設定→バックアップから手で作れます）。"; }
      renderMonthEnd();
    } catch (err) {
      console.error("[月次締め]", err);
      $("cl-close").disabled = false;
      $("cl-msg").textContent = "失敗しました：" + (err.code || err.message);
    }
  });
  if ($("cl-reopen")) $("cl-reopen").addEventListener("click", async () => {
    if (!window.confirm(`${month}月度の締めを解除します。解除の記録は残ります。よろしいですか？`)) return;
    try { await reopenMonth(month); renderMonthEnd(); } catch (err) { console.error(err); showError("解除に失敗しました：" + (err.code || err.message)); }
  });
  view.querySelectorAll("button[data-goto]").forEach((b) => b.addEventListener("click", () => { me.month = b.dataset.goto; me.date = ""; renderMonthEnd(); }));
}

// 締めた月の一覧（締めた後に変わった月に⚠）
function closedListHtml(all) {
  const list = (state.closings || []).filter((c) => c.status === "closed").sort((p, q) => (p.month < q.month ? 1 : -1));
  if (!list.length) return "";
  return `<section class="panel"><h3><span class="bar"></span>締めた月の一覧</h3><div class="tablewrap"><table class="tbl" style="min-width:0"><thead><tr><th>月度</th><th>状態</th><th></th></tr></thead><tbody>
    ${list.map((c) => { const n = diffBalances(c.balances, balancesAt(all, lastDayOf(c.month))).length;
      return `<tr><td>${esc(c.month)}</td><td>${n ? `<span class="ng">⚠ 締めた後に変わった（${n}科目）</span>` : `<span class="ok">✓ 控えと一致</span>`}</td><td><button type="button" class="sub" data-goto="${esc(c.month)}">開く</button></td></tr>`; }).join("")}
    </tbody></table></div></section>`;
}

export async function closeMonth(month, balances, count, manual) {
  await setDoc(doc(col("closings"), month.replace(".", "_")), {
    month, status: "closed", closedAt: serverTimestamp(), balances, voucherCount: count, manual,
    history: arrayUnion({ at: Date.now(), act: "締める" })
  }, { merge: true });
  await loadClosings();
}
export async function reopenMonth(month) {
  await setDoc(doc(col("closings"), month.replace(".", "_")), { month, status: "open", reopenedAt: serverTimestamp(), history: arrayUnion({ at: Date.now(), act: "解除" }) }, { merge: true });
  await loadClosings();
}
