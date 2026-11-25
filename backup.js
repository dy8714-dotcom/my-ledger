// バックアップ（手順G）：全データのJSON、仕訳のCSV
import { state, col, loadAllVouchers } from "./state.js?v=0.1G";
import { $, esc, ymd, showError } from "./util.js?v=0.1G";
import { getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

function save(text, filename, mime, bom) {
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

async function dumpAll() {
  const out = { app: "my-ledger", format: 1, exportedAt: new Date().toISOString(), uid: state.user.uid };
  for (const name of ["accounts", "fields", "parties", "vouchers"]) {
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

const q = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;

// 1明細行＝1行（複合仕訳も、同じ伝番で何行かに分かれる）
function voucherCsv(list) {
  const acc = (id) => state.accountsById[id] || {};
  const head = ["日付", "月度", "伝番", "借貸", "科目番号", "科目", "金額", "税区分", "摘要", "分野", "取引先", "事業", "印", "後日記帳", "記帳日"];
  const rows = [head.map(q).join(",")];
  list.forEach((v) => {
    (v.lines || []).forEach((l) => {
      rows.push([
        v.date, v.month, `${v.month}-${v.seq}`,
        l.side === "debit" ? "借方" : "貸方",
        acc(l.accId).no ?? "", q(acc(l.accId).name || l.accId), l.amount ?? "", q(l.tax || ""), q(l.memo || ""),
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
      <p><button type="button" class="primary" id="bk-json">全データをダウンロード</button> <span id="bk-json-msg" class="note"></span></p>
      <h4>② 仕訳をCSVでダウンロード</h4>
      <p class="note">Excelで開けるCSVです。複合仕訳は同じ伝番の行が複数に分かれます。</p>
      <p><select id="bk-year"></select>
      <button type="button" class="sub" id="bk-csv">仕訳CSVをダウンロード</button> <span id="bk-csv-msg" class="note"></span></p>
    </div>`;
  const stamp = () => ymd(new Date()).replace(/-/g, "");

  $("bk-json").addEventListener("click", async () => {
    $("bk-json-msg").textContent = "読み込み中…";
    try {
      const data = await dumpAll();
      save(JSON.stringify(data, null, 1), `my-ledger-backup-${stamp()}.json`, "application/json", false);
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
      save(voucherCsv(list), `仕訳_${y || "全期間"}_${stamp()}.csv`, "text/csv;charset=utf-8", true);
      $("bk-csv-msg").textContent = `保存しました（${list.length}件）`;
    } catch (err) { $("bk-csv-msg").textContent = ""; showError("CSVの出力に失敗しました：" + err.message); }
  });
}
