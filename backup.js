// バックアップ（手順G）：全データのJSON、仕訳のCSV
import { state, col, db, loadAll, loadVouchers, loadAllVouchers } from "./state.js?v=0.2I9b";
import { $, esc, ymd, showError, openModal, closeModal } from "./util.js?v=0.2I9b";
import { collection, getDocs, getDoc, setDoc, deleteDoc, writeBatch, doc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { requestToken, saveToDrive, KEEP_FILES } from "./drive.js?v=0.2I9b";

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
  for (const name of ["accounts", "fields", "parties", "vouchers", "assets", "valuations", "closings", "recurring"]) {
    const snap = await getDocs(col(name));
    out[name] = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
  }
  out.meta = {};
  for (const id of ["stats", "searches", "openings", "snapshots"]) {
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

// 全データをGoogleドライブに保存する（ボタンを押した直後に呼ぶ。最初に「許可」の画面が出る）
export async function saveBackupToDrive(prefix = "my-ledger-backup") {
  const token = await requestToken();
  let data = null;
  const r = await saveToDrive(token, `${prefix}-${stampNow()}.json`, async () => { data = await dumpAll(); return JSON.stringify(data, null, 1); });
  try {
    state.lastBackupAt = Date.now(); state.lastDriveAt = state.lastBackupAt;
    await setDoc(doc(col("meta"), "backup"), { lastAt: state.lastBackupAt, driveAt: state.lastDriveAt }, { merge: true });
  } catch (err) { console.error("[バックアップ] 日時の記録に失敗", err); }
  renderBackupBanner();
  return { ...r, data };
}

export function renderBackupBanner() {
  const el = $("backup-banner");
  if (!el) return;
  const last = state.lastBackupAt;
  const days = last ? Math.floor((Date.now() - last) / DAY) : null;
  if (!state.user || state.backupSnoozed || (last && days < BACKUP_DAYS)) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>${last ? `最後のバックアップから<strong>${days}日</strong>たっています。` : "バックアップを保存した記録がまだありません。"}</span>
    <button type="button" class="primary" id="bk-drive">Googleドライブに保存</button>
    <button type="button" class="sub" id="bk-now">PCにダウンロード</button>
    <button type="button" class="sub" id="bk-later">あとで</button><span id="bk-msg" class="note"></span>`;
  $("bk-later").addEventListener("click", () => { state.backupSnoozed = true; el.hidden = true; });
  $("bk-drive").addEventListener("click", async () => {
    $("bk-drive").disabled = true; $("bk-msg").textContent = "Googleの許可の画面を確認してください…";
    try {
      const r = await saveBackupToDrive();
      el.hidden = false;
      el.innerHTML = `<span>ドライブに保存しました（${esc(r.name)}）。</span> <a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">ドライブのフォルダを開く</a>`;
    } catch (err) { $("bk-drive").disabled = false; $("bk-msg").textContent = ""; showError("ドライブへの保存に失敗しました：" + err.message); }
  });
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

// ---------- Firestore内の控え（I5a） ----------
// 全データを、Firestoreの中の別の場所（backups）にも保存しておく。1文書は約1MBまでなので、小分けにして入れる
const COPY_COLLS = ["accounts", "fields", "parties", "vouchers", "assets", "valuations", "closings", "recurring"];
const PART_BYTES = 500000;
const KEEP_COPIES = 20;
const byteLen = (s) => new TextEncoder().encode(s).length;
const partsCol = (id) => collection(db, "users", state.user.uid, "backups", id, "parts");

// dumpAll の結果を、小分け（parts）に分ける
export function splitParts(data) {
  const parts = [];
  COPY_COLLS.forEach((c) => {
    let cur = [], size = 0;
    const flush = () => { if (cur.length) { parts.push({ n: parts.length, coll: c, json: JSON.stringify(cur) }); cur = []; size = 0; } };
    (data[c] || []).forEach((item) => {
      const len = byteLen(JSON.stringify(item));
      if (size + len > PART_BYTES) flush();
      cur.push(item); size += len;
    });
    flush();
  });
  parts.push({ n: parts.length, coll: "meta", json: JSON.stringify(data.meta || {}) });
  return parts;
}
// 小分けから元のデータに戻す
export function joinParts(parts) {
  const data = { meta: {} };
  COPY_COLLS.forEach((c) => { data[c] = []; });
  parts.sort((a, b) => a.n - b.n).forEach((p) => {
    if (p.coll === "meta") data.meta = JSON.parse(p.json);
    else data[p.coll] = data[p.coll].concat(JSON.parse(p.json));
  });
  return data;
}

export async function listCopies() {
  const snap = await getDocs(col("backups"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
}

// いまの全データの控えを、Firestoreの中に作る
export async function makeCopy(reason) {
  const data = await dumpAll();
  const parts = splitParts(data);
  const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  for (let i = 0; i < parts.length; i += 5) {
    const batch = writeBatch(db);
    parts.slice(i, i + 5).forEach((p) => batch.set(doc(partsCol(id), String(p.n).padStart(3, "0")), p));
    await batch.commit();
  }
  const counts = {};
  COPY_COLLS.forEach((c) => { counts[c] = (data[c] || []).length; });
  const meta = { createdAt: Date.now(), reason, counts, parts: parts.length, bytes: parts.reduce((s, p) => s + byteLen(p.json), 0) };
  await setDoc(doc(col("backups"), id), meta); // 文書が揃ってから最後に記録（途中で止まった控えは一覧に出ない）
  await pruneCopies();
  return { id, ...meta };
}

async function deleteCopy(id) {
  const snap = await getDocs(partsCol(id));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(doc(col("backups"), id));
}
async function pruneCopies() {
  const list = await listCopies();
  for (const c of list.slice(KEEP_COPIES)) await deleteCopy(c.id); // 古い控えから消す（最新の20件を残す）
}

export async function loadCopy(id) {
  const snap = await getDocs(partsCol(id));
  return joinParts(snap.docs.map((d) => d.data()));
}

// 控えの時点に戻す。直前に、いまの状態の控えとJSONを必ず作る
export async function restoreCopy(id, onStep) {
  onStep && onStep("いまの状態の控えを作っています…");
  await makeCopy("復元前（自動）");
  await downloadFullBackup("my-ledger-backup-復元前");
  onStep && onStep("控えを読み込んでいます…");
  const data = await loadCopy(id);
  for (const c of COPY_COLLS) {
    onStep && onStep(`${c} を戻しています…`);
    const have = await getDocs(col(c));
    const want = new Map((data[c] || []).map((x) => [x.id, x]));
    const ops = [];
    want.forEach((x, k) => { const { id: _i, ...rest } = x; ops.push((b) => b.set(doc(col(c), k), rest)); });
    have.docs.forEach((d) => { if (!want.has(d.id)) ops.push((b) => b.delete(d.ref)); });
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((f) => f(batch));
      await batch.commit();
    }
  }
  for (const k of Object.keys(data.meta || {})) await setDoc(doc(col("meta"), k), data.meta[k]);
  onStep && onStep("画面を読み込み直しています…");
  state.allVouchers = null;
  await loadAll();
  await loadVouchers();
}

export function renderBackup() {
  $("settings-body").innerHTML = `
    <div class="card" style="max-width:720px">
      <h3>バックアップ</h3>
      <p class="note">データはFirebase（クラウド）に保存されています。念のため、定期的に自分のPCにも保存しておくと安心です。</p>
      <h4>Googleドライブに保存（おすすめ）</h4>
      <p class="note">全データのJSONを、あなたのGoogleドライブの「マイ帳簿バックアップ」フォルダに保存します。パソコンやFirebaseに何かあっても、ここから戻せます。押すと、Googleの「許可」の小さな画面が出ます（このサイトが作ったファイルだけを扱う権限です）。新しい${KEEP_FILES}件を残し、それより古いものはごみ箱に移します。</p>
      <p class="note" id="bk-drive-last"></p>
      <p><button type="button" class="primary" id="bk-drive-go">Googleドライブに保存</button> <span id="bk-drive-msg" class="note"></span></p>
      <h4>① 全データをPCにダウンロード（JSON）</h4>
      <p class="note">科目・分野・取引先・仕訳・入力パターン・保存した検索を、すべて1つのファイルにまとめます。復元（読み込み）は手順H以降で作ります。</p>
      <p class="note" id="bk-last"></p>
      <p><button type="button" class="primary" id="bk-json">全データをダウンロード</button> <span id="bk-json-msg" class="note"></span></p>
      <h4>② Firestore内の控え（すぐ戻せる）</h4>
      <p class="note">全データの控えを、このサイトのデータの中にも保存します。月次締めのときに自動で作り、いつでも手で作ることもできます。最新の20件を残します。Googleドライブへの保存は、次の版で追加します。</p>
      <p><button type="button" class="sub" id="cp-make">いま控えを作る</button> <span id="cp-msg" class="note"></span></p>
      <div id="cp-list"></div>
      <h4>③ 仕訳をCSVでダウンロード</h4>
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
  const drawDrive = () => {
    const l = state.lastDriveAt;
    $("bk-drive-last").textContent = l ? `ドライブへの最後の保存：${ymd(new Date(l))}（${Math.floor((Date.now() - l) / DAY)}日前）` : "ドライブに保存した記録は、まだありません。";
  };
  drawDrive();
  $("bk-drive-go").addEventListener("click", async () => {
    $("bk-drive-go").disabled = true; $("bk-drive-msg").textContent = "Googleの許可の画面を確認してください…";
    try {
      const r = await saveBackupToDrive();
      drawLast(); drawDrive();
      $("bk-drive-msg").innerHTML = `保存しました（${esc(r.name)}${r.trimmed ? `／古い${r.trimmed}件をごみ箱へ` : ""}）。<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">ドライブのフォルダを開く</a>`;
    } catch (err) { $("bk-drive-msg").textContent = ""; showError("ドライブへの保存に失敗しました：" + err.message); }
    $("bk-drive-go").disabled = false;
  });

  $("bk-json").addEventListener("click", async () => {
    $("bk-json-msg").textContent = "読み込み中…";
    try {
      const data = await downloadFullBackup();
      drawLast();
      $("bk-json-msg").textContent = `保存しました（仕訳${data.vouchers.length}件・科目${data.accounts.length}・取引先${data.parties.length}）`;
    } catch (err) { $("bk-json-msg").textContent = ""; showError("バックアップに失敗しました：" + err.message); }
  });

  drawCopies();
  $("cp-make").addEventListener("click", async () => {
    $("cp-make").disabled = true; $("cp-msg").textContent = "作っています…";
    try { const r = await makeCopy("手動"); $("cp-msg").textContent = `作りました（仕訳${r.counts.vouchers}件）`; drawCopies(); }
    catch (err) { console.error(err); $("cp-msg").textContent = "失敗しました：" + (err.code || err.message); }
    $("cp-make").disabled = false;
  });
  $("cp-list").addEventListener("click", async (e) => {
    const dl = e.target.closest("button[data-dl]"), rs = e.target.closest("button[data-rs]");
    if (dl) {
      dl.disabled = true;
      try {
        const data = await loadCopy(dl.dataset.dl);
        saveFile(JSON.stringify({ app: "my-ledger", format: 1, fromCopy: dl.dataset.dl, ...data }, null, 1), `my-ledger-控え-${stampNow()}.json`, "application/json", false);
      } catch (err) { console.error(err); showError("ダウンロードに失敗しました：" + (err.code || err.message)); }
      dl.disabled = false;
    }
    if (rs) openRestore(rs.dataset.rs);
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

async function drawCopies() {
  const box = $("cp-list");
  if (!box) return;
  let list;
  try { list = await listCopies(); } catch (err) { box.innerHTML = `<p class="note">読み込めませんでした：${esc(err.code || err.message)}</p>`; return; }
  box.innerHTML = list.length ? `<table class="tbl" style="min-width:0"><thead><tr><th>作った日時</th><th>きっかけ</th><th class="amt">仕訳</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr><td>${esc(new Date(c.createdAt).toLocaleString("ja-JP"))}</td><td>${esc(c.reason)}</td><td class="amt">${c.counts ? c.counts.vouchers : ""}</td>
    <td><button type="button" class="sub" data-dl="${esc(c.id)}">JSONで保存</button> <button type="button" class="danger" data-rs="${esc(c.id)}">この時点に戻す</button></td></tr>`).join("")}</tbody></table>` : `<p class="note">まだ控えがありません。</p>`;
}

function openRestore(id) {
  openModal(`<div class="dialog" role="dialog" aria-modal="true">
    <h2>この控えの時点に戻します</h2>
    <p>いまのデータは、この控えの内容で<strong>置き換わります</strong>（控えのあとに記帳したものは消えます）。</p>
    <p class="note">実行する直前に、いまの状態の控えをFirestore内に作り、全データのJSONもPCに保存します。万一のときは、そこからまた戻せます。</p>
    <label><input type="checkbox" id="rs-ok"> 置き換わることを理解しました</label>
    <p id="rs-msg" class="note"></p>
    <div class="actions"><button type="button" class="sub" id="rs-cancel">やめる</button><button type="button" class="danger" id="rs-go" disabled>この時点に戻す</button></div></div>`);
  $("rs-ok").addEventListener("change", (e) => { $("rs-go").disabled = !e.target.checked; });
  $("rs-cancel").addEventListener("click", closeModal);
  $("rs-go").addEventListener("click", async () => {
    $("rs-go").disabled = true; $("rs-cancel").disabled = true; $("rs-ok").disabled = true;
    try {
      await restoreCopy(id, (t) => { $("rs-msg").textContent = t; });
      $("rs-msg").textContent = "戻しました。";
      $("rs-cancel").disabled = false; $("rs-cancel").textContent = "閉じる";
      drawCopies();
    } catch (err) {
      console.error("[復元]", err);
      $("rs-msg").textContent = "失敗しました：" + (err.code || err.message) + "（途中まで戻っている可能性があります。直前に作った控えとJSONから、やり直せます）";
      $("rs-cancel").disabled = false; $("rs-cancel").textContent = "閉じる";
    }
  });
}
