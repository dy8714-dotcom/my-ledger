// 仕訳の種別（I11a）：kind と batchId。自動で作る仕訳に付け、まとめて取り消せるようにする
import { state, col, db, loadAllVouchers, loadVouchers } from "./state.js?v=0.2I11d";
import { $, esc, yen, showError } from "./util.js?v=0.2I11d";
import { doc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { downloadFullBackup } from "./backup.js?v=0.2I11d";

// normal は「kind が無いとき」と同じ。札は normal 以外に出す
export const KINDS = [
  ["normal", "通常", "日々の記帳"],
  ["opening", "期首", "期首の仕訳（25.9-1）"],
  ["salary", "給与", "給与の入力画面で作った仕訳"],
  ["depr", "償却", "月割り償却"],
  ["valuation", "評価", "評価替え"],
  ["adjust", "残高合わせ", "月末の残高合わせ"],
  ["bnpl", "後払い", "後払いの引き落とし"],
  ["alloc", "按分", "毎月の按分（生活→事業の振り替え）"],
  ["closing", "決算", "年次決算の整理"]
];
export const KIND_NAME = Object.fromEntries(KINDS.map(([k, n]) => [k, n]));

export const kindOf = (v) => (v && v.kind) || "normal";

// 札（記帳一覧・元帳用）。通常には付けない
export function kindChip(v) {
  const k = kindOf(v);
  if (k === "normal") return "";
  return ` <span class="chip kind kind-${esc(k)}">${esc(KIND_NAME[k] || k)}</span>`;
}

// 昔の仕訳（kind が無いもの）から、種別を推定する。決められないものは null（通常のまま）
export function inferKind(v) {
  if (v.kind) return null;
  if (v.month === "25.9" && Number(v.seq) === 1) return "opening";
  if (v.auto === "valuation" || /^eval_/.test(v.id || "")) return "valuation";
  if (v.auto === "depreciation" || v.assetId) return "depr";
  return null;
}

// 補う対象：{ vs: [{v, kind, batchId}], counts }
export function planBackfill(list) {
  const vs = [], counts = {};
  list.forEach((v) => {
    if (v.deleted) return;
    const kind = inferKind(v);
    if (!kind) return;
    const batchId = v.batchId || (kind === "depr" ? `depr-${v.month}` : kind === "valuation" ? `val-${v.month}` : kind === "opening" ? "opening" : "");
    vs.push({ v, kind, batchId });
    counts[kind] = (counts[kind] || 0) + 1;
  });
  return { vs, counts };
}

export function countByKind(list) {
  const c = {};
  list.forEach((v) => { if (!v.deleted) c[kindOf(v)] = (c[kindOf(v)] || 0) + 1; });
  return c;
}

// 同じ batchId の仕訳を探す（削除済みを除く）
export const findBatch = (list, batchId) => list.filter((v) => !v.deleted && v.batchId === batchId);

// 同じ batchId の仕訳を、まとめて「削除済み」にする（実行の直前に自動バックアップ）。
// 年次決算や按分の「取り消して作り直す」で使う
export async function voidBatch(batchId, { backup = true } = {}) {
  const list = await loadAllVouchers();
  const vs = findBatch(list, batchId);
  if (!vs.length) return 0;
  if (backup) await downloadFullBackup(`my-ledger-backup-${batchId}取り消し前`);
  for (let i = 0; i < vs.length; i += 400) {
    const b = writeBatch(db);
    vs.slice(i, i + 400).forEach((v) => b.update(doc(col("vouchers"), v.id), { deleted: true, deletedAt: Date.now(), updatedAt: serverTimestamp() }));
    await b.commit();
  }
  state.allVouchers = null;
  await loadVouchers();
  return vs.length;
}

// ---------- 設定の「仕訳の種別」 ----------
export async function renderKinds() {
  const host = $("settings-body");
  host.innerHTML = `<section class="panel"><p class="note">調べています…</p></section>`;
  let list;
  try { list = await loadAllVouchers(); } catch (err) { host.innerHTML = ""; showError("読み込みに失敗しました：" + (err.code || err.message)); return; }
  draw(host, list);
}

function draw(host, list) {
  const counts = countByKind(list);
  const plan = planBackfill(list);
  host.innerHTML = `<section class="panel">
    <h3><span class="bar"></span>仕訳の種別</h3>
    <p class="note">仕訳には「種別」があります。日々の記帳は「通常」で、給与・償却・評価替え・残高合わせ・後払い・按分・決算など、自動や専用の画面で作る仕訳は別の種別になります。記帳一覧と元帳に札が出て、元帳・検索の「種別」で絞れます。</p>
    <div class="tablewrap"><table class="tbl mtbl"><thead><tr><th>種別</th><th>内容</th><th class="amt">仕訳の数</th></tr></thead><tbody>
      ${KINDS.map(([k, n, d]) => `<tr><td>${k === "normal" ? esc(n) : `<span class="chip kind kind-${k}">${esc(n)}</span>`}</td><td>${esc(d)}</td><td class="amt num">${yen(counts[k] || 0)}</td></tr>`).join("")}
    </tbody></table></div>
    <h3 style="margin-top:18px"><span class="bar"></span>以前の仕訳に種別を補う（1回だけ）</h3>
    ${plan.vs.length ? `<p>種別が付いていない仕訳のうち、<strong>${plan.vs.length}件</strong>に種別を補えます（${Object.entries(plan.counts).map(([k, n]) => `${esc(KIND_NAME[k])} ${n}件`).join("、")}）。金額や科目は変わりません。それ以外の仕訳は「通常」のままです。</p>
      <p class="note">実行の直前に、全データのバックアップ（JSONファイル）が自動でダウンロードされます。</p>
      <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="kd-run">バックアップして種別を補う</button></div>
      <p class="note" id="kd-msg"></p>` : `<p class="note">補う仕訳はありません（すべて済んでいます）。</p>`}
  </section>`;
  const run = $("kd-run");
  if (run) run.addEventListener("click", async () => {
    run.disabled = true;
    const m = $("kd-msg");
    try {
      m.textContent = "バックアップを保存しています…";
      await downloadFullBackup("my-ledger-backup-種別を補う前");
      for (let i = 0; i < plan.vs.length; i += 400) {
        m.textContent = `補っています… ${Math.min(i + 400, plan.vs.length)}／${plan.vs.length}`;
        const b = writeBatch(db);
        plan.vs.slice(i, i + 400).forEach(({ v, kind, batchId }) => b.update(doc(col("vouchers"), v.id), { kind, ...(batchId ? { batchId } : {}), updatedAt: serverTimestamp() }));
        await b.commit();
      }
      state.allVouchers = null;
      await loadVouchers();
      m.textContent = `完了しました（${plan.vs.length}件）。`;
      renderKinds();
    } catch (err) {
      console.error("[種別を補う]", err);
      m.textContent = "失敗しました：" + (err.code || err.message) + "（途中まで補われている可能性があります。もう一度開いて確認してください）";
      state.allVouchers = null;
    }
  });
}
