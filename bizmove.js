// 科目を指定して、全期間の「事業／生活」の印をまとめて付け替える（設定の一つのタブ）
import { state, col, db, loadAllVouchers, loadVouchers } from "./state.js?v=0.2I11a";
import { downloadFullBackup } from "./backup.js?v=0.2I11a";
import { $, esc, yen, hk, openModal, closeModal, showError } from "./util.js?v=0.2I11a";
import { doc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const isPL = (a) => !!a && (a.kind === "expense" || a.kind === "revenue");
const bizOf = (l) => (l.biz === "biz" ? "biz" : "life");
const NAME = { biz: "事業", life: "生活" };

// 対象の洗い出し：科目 accId の明細で、印が from のもの
export function findTargets(list, accId, from) {
  const vs = [];
  let lines = 0, sum = 0;
  list.forEach((v) => {
    const hit = (v.lines || []).filter((l) => l.accId === accId && bizOf(l) === from);
    if (hit.length) { vs.push(v); lines += hit.length; sum += hit.reduce((s, l) => s + l.amount, 0); }
  });
  return { vs, lines, sum };
}

export function retagLines(v, accId, from, to) {
  return (v.lines || []).map((l) => (l.accId === accId && bizOf(l) === from ? { ...l, biz: to } : l));
}

export async function renderBizMove() {
  const accs = state.accounts.filter((a) => isPL(a) && !a.hidden).sort((x, y) => x.no - y.no);
  const host = $("settings-body");
  const box = document.createElement("section");
  box.className = "panel";
  box.innerHTML = `
    <h3><span class="bar"></span>事業／生活の付け替え（全期間）</h3>
    <p class="note">ある科目の明細について、事業の印を生活に、または生活の印を事業に、全期間まとめて付け替えます。金額や科目は変わりません。P/Lの「Ⅰ 事業」と「Ⅳ 生活費」への振り分けだけが変わります。同じ仕訳の中の、ほかの科目の明細は変わりません。</p>
    <div class="fgrid" style="max-width:640px">
      <label>科目<select id="bm-acc">${accs.map((a) => `<option value="${esc(a.id)}">${esc(a.no)} ${esc(hk(a.name))}</option>`).join("")}</select></label>
      <label>付け替え方<select id="bm-dir"><option value="biz>life">事業 → 生活</option><option value="life>biz">生活 → 事業</option></select></label>
    </div>
    <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="bm-check">対象を調べる</button></div>
    <div id="bm-out"></div>`;
  host.innerHTML = "";
  host.appendChild(box);
  $("bm-check").addEventListener("click", async () => {
    const out = $("bm-out");
    out.innerHTML = `<p class="note">調べています…</p>`;
    let list;
    try { list = await loadAllVouchers(); } catch (err) { out.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
    const accId = $("bm-acc").value, [from, to] = $("bm-dir").value.split(">");
    const a = state.accountsById[accId];
    const { vs, lines, sum } = findTargets(list, accId, from);
    if (!vs.length) { out.innerHTML = `<p class="note">${esc(a.no + " " + hk(a.name))}で、印が「${NAME[from]}」の明細はありません。</p>`; return; }
    const months = [...new Set(vs.map((v) => v.month))];
    const closed = months.filter((m) => (state.closings || []).some((c) => c.month === m && c.status === "closed"));
    out.innerHTML = `<p><strong>${esc(a.no + " " + hk(a.name))}</strong>の「${NAME[from]}」の明細：<strong>${lines}行（${vs.length}件の仕訳）、合計 ¥${yen(sum)}</strong>（${esc(months.length)}か月分）</p>
      ${closed.length ? `<p class="note"><strong>締め済みの月が含まれます（${esc(closed.join("・"))}）。</strong>P/Lの振り分けが、締めたときと変わることがあります。</p>` : ""}
      <p class="note">実行の直前に、全データのバックアップ（JSONファイル）が自動でダウンロードされます。</p>
      <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="bm-run">バックアップして「${NAME[to]}」に付け替える</button></div>
      <p class="note" id="bm-msg"></p>`;
    $("bm-run").addEventListener("click", async () => {
      $("bm-run").disabled = true;
      const m = $("bm-msg");
      try {
        m.textContent = "バックアップを保存しています…";
        await downloadFullBackup("my-ledger-backup-事業生活の付け替え前");
        for (let i = 0; i < vs.length; i += 400) {
          m.textContent = `付け替えています… ${Math.min(i + 400, vs.length)}／${vs.length}`;
          const batch = writeBatch(db);
          vs.slice(i, i + 400).forEach((v) => batch.update(doc(col("vouchers"), v.id), { lines: retagLines(v, accId, from, to), updatedAt: serverTimestamp() }));
          await batch.commit();
        }
        await loadVouchers();
        m.textContent = `完了しました（${lines}行）。P/Lで確認してください。`;
        $("bm-run").hidden = true;
      } catch (err) {
        console.error("[事業/生活の全期間付け替え]", err);
        m.textContent = "失敗しました：" + (err.code || err.message) + "（途中まで付け替わっている可能性があります。もう一度「対象を調べる」で確認してください）";
        loadVouchers().catch(() => {});
      }
    });
  });
}
