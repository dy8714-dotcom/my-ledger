// 月末（手順I3）：金融資産の評価替え
import { state, col, db, loadAllVouchers, loadVouchers, fetchMonthVouchers } from "./state.js?v=0.2I3";
import { $, esc, yen, ymd, hk, shiftMonth, monthOf, WD, showError } from "./util.js?v=0.2I3";
import { doc, getDocs, writeBatch, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

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

export async function renderMonthEnd() {
  const view = $("view");
  const me = (state.me = state.me || { month: state.month, date: "" });
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
          month, seq, date, entryDate: today, late: today > date, fieldId: "", partyId: "", mark: "", auto: "valuation", accId: r.acc.id,
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
