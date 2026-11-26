// 設定の「削除した仕訳」：1件の削除は「削除済み」として残し、30日間は戻せる
import { state, loadDeletedVouchers, loadVouchers, RESTORE_DAYS } from "./state.js?v=0.2I7a";
import { $, esc, yen, hk, showError } from "./util.js?v=0.2I7a";
import { col } from "./state.js?v=0.2I7a";
import { doc, updateDoc, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const DAY = 24 * 60 * 60 * 1000;
const accName = (id) => (state.accountsById[id] || {}).name || id;
const names = (v, side) => [...new Set((v.lines || []).filter((l) => l.side === side).map((l) => accName(l.accId)))].join("・");

export async function renderDeleted() {
  const body = $("settings-body");
  body.innerHTML = `<p class="note">読み込み中…</p>`;
  let list;
  try { list = await loadDeletedVouchers(); }
  catch (err) { body.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  const now = Date.now();
  const left = (v) => RESTORE_DAYS - Math.floor((now - (v.deletedAt || 0)) / DAY);
  const ok = list.filter((v) => left(v) > 0), old = list.length - ok.length;
  body.innerHTML = `
    <div class="card" style="max-width:1000px">
      <h3>削除した仕訳</h3>
      <p class="note">記帳画面で削除した仕訳は、完全には消えず、ここに${RESTORE_DAYS}日間残ります。集計・試算表・元帳には含まれません。「元に戻す」で、もとの伝番のまま戻ります。${old ? `（${RESTORE_DAYS}日をすぎて戻せないもの：${old}件）` : ""}</p>
      ${ok.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>伝番</th><th>日付</th><th>借方</th><th>貸方</th><th>取引先</th><th class="amt">金額</th><th>削除した日</th><th>残り</th><th></th></tr></thead><tbody>
      ${ok.map((v) => `<tr><td>${esc(v.month)}-${esc(v.seq)}</td><td>${esc(v.date)}</td><td>${esc(names(v, "debit"))}</td><td>${esc(names(v, "credit"))}</td>
        <td>${esc(hk((state.partiesById[v.partyId] || {}).name || ""))}</td>
        <td class="amt">${yen((v.lines || []).filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0))}</td>
        <td>${esc(new Date(v.deletedAt).toLocaleDateString("ja-JP"))}</td><td>あと${left(v)}日</td>
        <td><button type="button" class="sub" data-restore="${esc(v.id)}">元に戻す</button></td></tr>`).join("")}</tbody></table></div>` : `<p>削除した仕訳はありません。</p>`}
      <p id="del-msg" class="note"></p>
    </div>`;
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-restore]");
    if (!b) return;
    b.disabled = true;
    try {
      await updateDoc(doc(col("vouchers"), b.dataset.restore), { deleted: deleteField(), deletedAt: deleteField(), updatedAt: serverTimestamp() });
      state.allVouchers = null;
      await loadVouchers();
      renderDeleted();
    } catch (err) { b.disabled = false; showError("元に戻せませんでした：" + (err.code || err.message)); }
  }, { once: true });
}
