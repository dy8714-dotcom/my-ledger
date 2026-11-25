// バックアップ（手順G）：全データのJSON、仕訳のCSV
import { state, col, loadAllVouchers } from "./state.js?v=0.2I1d";
import { $, esc, ymd, showError } from "./util.js?v=0.2I1d";
import { getDocs, getDoc, setDoc, doc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

export function saveFile(text, filename, mime, bom) {
  const blob = new Blob([(bom ? "﻿" : "") + text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

// Firestoreの日時などをJSONにできる形へ
function plain(v) {
  if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = plain(v[k]); });
    return o;
  }
  return v;
}

export async function dumpAll() {
  const out = { app: "my-ledger", format: 1, exportedAt: new Date().toISOString(), uid: state.user.uid };
  for (const name of ["accounts", "fields", "parties", "vouchers", "assets"]) {
    const snap = await getDocs(col(name));
    out[name] = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
  }
  out.meta = {};
  for (const id of ["stats", "searches"]) {
    const s = await getDoc(doc(col("meta"), id));
    if (s.exists()) out.meta[id] = plain(s.data());
  }
  return out;
}

export const stampNow = () => ymd(new Date()).replace(/-/g, "") + "-" + new Date().toTimeString().slice(0, 5).replace(":", "");

// ---------- バックアップの催促（最後の保存から7日たったら画面に出す） ----------
export const BACKUP_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

// 全データをJSONでPCに保存し、「最後に保存した日時」を記録する
export async function downloadFullBackup(prefix = "my-ledger-backup") {
  const data = await dumpAll();
  saveFile(JSON.stringify(data, null, 1), `${prefix}-${stampNow()}.json`, "application/json", false);
  try {
    state.lastBackupAt = Date.now();
    await setDoc(doc(col("meta"), "backup"), { lastAt: state.lastBackupAt }, { merge: true });
  } catch (err) { console.error("[バックアップ] 日時の記録に失敗", err); }
  renderBackupBanner();
  return data;
}

export function renderBackupBanner() {
  const el = $("backup-banner");
  if (!el) return;
  const last = state.lastBackupAt;
  const days = last ? Math.floor((Date.now() - last) / DAY) : null;
  if (!state.user || state.backupSnoozed || (last && days < BACKUP_DAYS)) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>${last ? `最後のバックアップから<strong>${days}日</strong>たっています。` : "バックアップを保存した記録がまだありません。"}</span>
    <button type="button" class="primary" id="bk-now">今すぐ保存（PCにダウンロード）</button>
    <button type="button" class="sub" id="bk-later">あとで</button><span id="bk-msg" class="note"></span>`;
  $("bk-later").addEventListener("click", () => { state.backupSnoozed = true; el.hidden = true; });
  $("bk-now").addEventListener("click", async () => {
    $("bk-now").disabled = true; $("bk-msg").textContent = "保存中…";
    try { await downloadFullBackup(); }
    catch (err) { $("bk-now").disabled = false; $("bk-msg").textContent = ""; showError("バックアップに失敗しました：" + err.message); }
  });
}

const q = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;

// 1明細行＝1行（複合仕訳も、同じ伝番で何行かに分かれる）
function voucherCsv(list) {
  const acc = (id) => state.accountsById[id] || {};
  const head = ["日付", "月度", "伝番", "借貸", "科目番号", "科目", "金額", "税率", "摘要", "タグ", "分野", "取引先", "事業", "印", "後日記帳", "記帳日"];
  const rows = [head.map(q).join(",")];
  list.forEach((v) => {
    (v.lines || []).forEach((l) => {
      rows.push([
        v.date, v.month, `${v.month}-${v.seq}`,
        l.side === "debit" ? "借方" : "貸方",
        acc(l.accId).no ?? "", q(acc(l.accId).name || l.accId), l.amount ?? "", l.tax ? l.tax : "", q(l.memo || ""), q((l.tags || []).join("・")),
        q((state.fieldsById[v.fieldId] || {}).name || ""), q((state.partiesById[v.partyId] || {}).name || ""),
        l.biz === "biz" ? "事業" : l.biz === "life" ? "生活" : "", q(v.mark || ""), v.late ? "後日" : "", v.entryDate || ""
      ].join(","));
    });
  });
  return rows.join("\r\n");
}

export function renderBackup() {
  $("settings-body").innerHTML = `
    <div class="card" style="max-width:720px">
      <h3>バックアップ</h3>
      <p class="note">データはFirebase（クラウド）に保存されています。念のため、定期的に自分のPCにも保存しておくと安心です。</p>
      <h4>① 全データをPCにダウンロード（JSON）</h4>
      <p class="note">科目・分野・取引先・仕訳・入力パターン・保存した検索を、すべて1つのファイルにまとめます。復元（読み込み）は手順H以降で作ります。</p>
      <p class="note" id="bk-last"></p>
      <p><button type="button" class="primary" id="bk-json">全データをダウンロード</button> <span id="bk-json-msg" class="note"></span></p>
      <h4>② 仕訳をCSVでダウンロード</h4>
      <p class="note">Excelで開けるCSVです。複合仕訳は同じ伝番の行が複数に分かれます。</p>
      <p><select id="bk-year"></select>
      <button type="button" class="sub" id="bk-csv">仕訳CSVをダウンロード</button> <span id="bk-csv-msg" class="note"></span></p>
    </div>`;
  const stamp = stampNow;
  const drawLast = () => {
    const l = state.lastBackupAt;
    $("bk-last").textContent = l ? `最後に保存：${ymd(new Date(l))}（${Math.floor((Date.now() - l) / DAY)}日前）。${BACKUP_DAYS}日たつと、画面の上にお知らせが出ます。` : `最後に保存した記録はまだありません。`;
  };
  drawLast();

  $("bk-json").addEventListener("click", async () => {
    $("bk-json-msg").textContent = "読み込み中…";
    try {
      const data = await downloadFullBackup();
      drawLast();
      $("bk-json-msg").textContent = `保存しました（仕訳${data.vouchers.length}件・科目${data.accounts.length}・取引先${data.parties.length}）`;
    } catch (err) { $("bk-json-msg").textContent = ""; showError("バックアップに失敗しました：" + err.message); }
  });

  loadAllVouchers().then((all) => {
    const years = [...new Set(all.map((v) => String(v.date).slice(0, 4)))].sort().reverse();
    $("bk-year").innerHTML = `<option value="">全期間</option>` + years.map((y) => `<option value="${esc(y)}">${esc(y)}年</option>`).join("");
  }).catch(() => {});

  $("bk-csv").addEventListener("click", async () => {
    $("bk-csv-msg").textContent = "読み込み中…";
    try {
      const all = await loadAllVouchers();
      const y = $("bk-year").value;
      const list = all.filter((v) => !y || String(v.date).startsWith(y))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
      saveFile(voucherCsv(list), `仕訳_${y || "全期間"}_${stamp()}.csv`, "text/csv;charset=utf-8", true);
      $("bk-csv-msg").textContent = `保存しました（${list.length}件）`;
    } catch (err) { $("bk-csv-msg").textContent = ""; showError("CSVの出力に失敗しました：" + err.message); }
  });
}
