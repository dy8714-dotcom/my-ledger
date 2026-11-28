// 古い給与の整理（手順I11e）：仮受金を使った古い方式の給与の仕訳を、月ごとに探して選び、バックアップしてから削除する
import { state, col, db, loadAllVouchers, loadVouchers, isClosed } from "./state.js?v=0.2I11f";
import { $, esc, yen, hk, showError } from "./util.js?v=0.2I11f";
import { doc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { downloadFullBackup } from "./backup.js?v=0.2I11f";

const NAMES = /給与|社保|社会保険|通勤手当|立替金回収|差額収入/;
const TOUCH = [38, 90, 95, 94, 25, 22]; // 給与まわりの科目の番号
const mi = (m) => { const [y, mm] = m.split(".").map((x) => parseInt(x, 10)); return y * 12 + mm - 1; };
const accNo = (id) => (state.accountsById[id] || {}).no;
const accName = (id) => { const a = state.accountsById[id]; return a ? `${a.no} ${hk(a.name)}` : "？"; };
const partyName = (v) => { const p = state.partiesById[v.partyId]; return p ? hk(p.name) : ""; };

// 古い方式の給与らしい仕訳か（取引先・摘要の言葉、または給与（90）の行がある）
export function isOldSalaryLike(v) {
  if (v.deleted || v.kind === "salary") return false;
  const memos = (v.lines || []).map((l) => l.memo || "").join(" ");
  return NAMES.test(partyName(v)) || NAMES.test(memos) || (v.lines || []).some((l) => accNo(l.accId) === 90);
}
// 給与まわりの科目に触れている仕訳か（候補として並べる）
export function touchesSalaryAcc(v) {
  if (v.deleted || v.kind === "salary") return false;
  return (v.lines || []).some((l) => TOUCH.includes(accNo(l.accId)));
}
export function monthSummary(list) {
  const m = {};
  list.forEach((v) => {
    if (v.deleted) return;
    const e = (m[v.month] = m[v.month] || { month: v.month, old: 0, hasNew: false });
    if (v.kind === "salary" && !/^bonus_/.test(v.id || "")) e.hasNew = true;
    else if (isOldSalaryLike(v)) e.old++;
  });
  return Object.values(m).filter((e) => e.old > 0 || e.hasNew).sort((a, b) => mi(b.month) - mi(a.month));
}
const lastDay = (month) => { const [y, mm] = month.split(".").map(Number); return new Date(Date.UTC(2000 + y, mm, 0)).toISOString().slice(0, 10); };
// 選んだ仕訳を消したあとの、月末の仮受金（38）の残高（貸方がプラス）
export function kariukeAfter(list, month, removeIds) {
  const a = state.accounts.find((x) => x.no === 38); if (!a) return 0;
  const end = lastDay(month);
  let b = 0;
  list.forEach((v) => { if (v.deleted || removeIds.has(v.id) || (v.date || "") > end) return; (v.lines || []).forEach((l) => { if (l.accId === a.id) b += l.side === "credit" ? l.amount : -l.amount; }); });
  return b;
}

let CL = { month: "", checked: new Set(), msg: "" };

export async function renderClean(host, { goSalary }) {
  host.innerHTML = `<p class="note">調べています…</p>`;
  let list;
  try { list = await loadAllVouchers(); } catch (err) { host.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  draw(host, list, goSalary);
}

function draw(host, list, goSalary) {
  const sums = monthSummary(list);
  const badge = (txt, cls) => `<span class="chip ${cls}">${txt}</span>`;
  let html = `<p class="note">仮受金を使った古い方式の給与の仕訳を、月ごとに探します。見つかった仕訳を選んで削除し、給与入力で入れ直します。1か月ずつ進めてください。</p>
  <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>月度</th><th>状態</th><th class="amt">古い仕訳</th><th></th></tr></thead><tbody>
  ${sums.map((e) => `<tr><td>${esc(e.month)}</td><td>${e.old ? badge("古い方式", "late") : ""} ${e.hasNew ? badge("新方式で記帳済み", "biz") : ""} ${isClosed(e.month) ? badge("締め済み", "biz") : ""}</td><td class="amt num">${e.old}件</td><td><button type="button" data-open="${esc(e.month)}">この月を開く</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">古い方式の給与は見つかりませんでした。</td></tr>`}
  </tbody></table></div>`;
  if (CL.month) {
    const vs = list.filter((v) => v.month === CL.month && touchesSalaryAcc(v)).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.seq || 0) - (b.seq || 0));
    const rows = vs.map((v) => {
      const ds = (v.lines || []).filter((l) => l.side === "debit"), cs = (v.lines || []).filter((l) => l.side === "credit");
      const tot = ds.reduce((x, l) => x + l.amount, 0);
      return `<tr><td><input type="checkbox" data-pick="${esc(v.id)}"${CL.checked.has(v.id) ? " checked" : ""}></td><td>${esc((v.date || "").slice(5).replace("-", "/"))}</td><td>${ds.map((l) => esc(accName(l.accId))).join("、")}</td><td>${cs.map((l) => esc(accName(l.accId))).join("、")}</td><td>${esc(partyName(v))}</td><td class="amt num">${yen(tot)}</td></tr>`;
    }).join("");
    const after = kariukeAfter(list, CL.month, CL.checked);
    html += `<h4 style="margin:16px 0 6px">${esc(CL.month)} の、給与まわりの仕訳 <span class="note" style="font-weight:400">取引先や摘要から探してチェックを入れています。ちがうものは外してください</span></h4>
    <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th></th><th>日付</th><th>借方</th><th>貸方</th><th>取引先</th><th class="amt">金額</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">この月に、給与まわりの仕訳はありません。</td></tr>`}</tbody></table></div>
    <div class="estgrid" style="margin-top:10px"><div class="est-card"><div class="est-l">選んだ仕訳</div><div class="est-v" id="cl-n">${CL.checked.size}件</div></div>
      <div class="est-card"><div class="est-l">消したあとの仮受金（${esc(CL.month)}末）</div><div class="est-v" id="cl-k">¥${yen(after)}</div><div class="est-s">0円なら、給与まわりだけをきれいに消せます</div></div></div>
    ${isClosed(CL.month) ? `<p class="note">${esc(CL.month)}は締め済みです。月末の画面で締めを外してから、削除してください。</p>` : ""}
    <div class="actions" style="justify-content:flex-start"><button type="button" class="danger" id="cl-del">バックアップして、選んだ仕訳を削除</button><button type="button" id="cl-redo">この月を給与入力で入れ直す</button></div>
    <p class="note" id="cl-msg">${esc(CL.msg)}</p><p class="note">削除した仕訳は、設定の「削除した仕訳」から30日間は戻せます。</p>`;
  }
  host.innerHTML = html;
  host.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    CL.month = b.dataset.open; CL.msg = "";
    CL.checked = new Set(list.filter((v) => v.month === CL.month && touchesSalaryAcc(v) && isOldSalaryLike(v)).map((v) => v.id));
    draw(host, list, goSalary);
  }));
  host.querySelectorAll("[data-pick]").forEach((c) => c.addEventListener("change", () => {
    if (c.checked) CL.checked.add(c.dataset.pick); else CL.checked.delete(c.dataset.pick);
    $("cl-n").textContent = CL.checked.size + "件"; $("cl-k").textContent = "¥" + yen(kariukeAfter(list, CL.month, CL.checked));
  }));
  const redo = $("cl-redo"); if (redo) redo.addEventListener("click", () => goSalary(CL.month));
  const del = $("cl-del");
  if (del) del.addEventListener("click", async () => {
    const msg = $("cl-msg");
    if (!CL.checked.size) { msg.textContent = "削除する仕訳を選んでください。"; return; }
    if (isClosed(CL.month)) { msg.textContent = `${CL.month}は締め済みです。月末の画面で締めを外してください。`; return; }
    if (!window.confirm(`${CL.month}の仕訳を${CL.checked.size}件削除します。先にバックアップを保存します。よろしいですか？`)) return;
    del.disabled = true;
    try {
      msg.textContent = "バックアップを保存しています…";
      await downloadFullBackup(`my-ledger-backup-古い給与の整理-${CL.month}`);
      const ids = [...CL.checked];
      for (let i = 0; i < ids.length; i += 400) {
        const b = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => b.update(doc(col("vouchers"), id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() }));
        await b.commit();
      }
      state.allVouchers = null; await loadVouchers();
      CL.msg = `${ids.length}件を削除しました。つづけて「この月を給与入力で入れ直す」を押してください。`; CL.checked = new Set();
      renderClean(host, { goSalary });
    } catch (err) {
      console.error("[古い給与の整理]", err); del.disabled = false;
      msg.textContent = "失敗しました：" + (err.code || err.message) + "（途中まで消えている可能性があります。開き直して確認してください）";
      state.allVouchers = null;
    }
  });
}
