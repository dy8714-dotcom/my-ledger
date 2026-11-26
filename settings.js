// 設定画面（科目・分野の台帳）
import { state, col, loadAll, loadParties } from "./state.js?v=0.2I7a";
import { $, esc, norm, hk, showError } from "./util.js?v=0.2I7a";
import { doc, setDoc, writeBatch, serverTimestamp, deleteField }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { SEED_ACCOUNTS, SEED_FIELDS, CATEGORIES, CATEGORY_COLORS, KIND_LABELS, sideOf }
  from "./seed.js?v=0.2I7a";
import { db } from "./state.js?v=0.2I7a";
import { renderImport } from "./importer.js?v=0.2I7a";
import { renderDeleted } from "./deleted.js?v=0.2I7a";
import { renderAssets } from "./assets.js?v=0.2I7a";
import { renderBackup } from "./backup.js?v=0.2I7a";
import { renderBizMove } from "./bizmove.js?v=0.2I7a";
import { renderRecurring } from "./recurring.js?v=0.2I7a";
import { patternsOf, sortPatterns, describePattern } from "./patterns.js?v=0.2I7a";

// ---------- 設定画面 ----------
export function renderSettings() {
  $("view").innerHTML = `
    <div class="subtabs">
      <button type="button" data-sub="accounts" class="${state.sub === "accounts" ? "active" : ""}">科目</button>
      <button type="button" data-sub="fields" class="${state.sub === "fields" ? "active" : ""}">分野</button>
      <button type="button" data-sub="parties" class="${state.sub === "parties" ? "active" : ""}">取引先</button>
      <button type="button" data-sub="recurring" class="${state.sub === "recurring" ? "active" : ""}">定期支払</button>
      <button type="button" data-sub="assets" class="${state.sub === "assets" ? "active" : ""}">月割り償却</button>
      <button type="button" data-sub="bizmove" class="${state.sub === "bizmove" ? "active" : ""}">事業/生活の付け替え</button>
      <button type="button" data-sub="backup" class="${state.sub === "backup" ? "active" : ""}">バックアップ</button>
      <button type="button" data-sub="import" class="${state.sub === "import" ? "active" : ""}">取り込み</button>
      <button type="button" data-sub="deleted" class="${state.sub === "deleted" ? "active" : ""}">削除した仕訳</button>
    </div>
    <div id="settings-body"></div>`;
  $("view").querySelector(".subtabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sub]");
    if (!b) return;
    state.sub = b.dataset.sub;
    state.q = "";
    renderSettings();
  });
  if (state.sub === "accounts") renderAccountsPage();
  else if (state.sub === "fields") renderFieldsPage();
  else if (state.sub === "recurring") renderRecurring();
  else if (state.sub === "assets") renderAssets();
  else if (state.sub === "bizmove") renderBizMove();
  else if (state.sub === "backup") renderBackup();
  else if (state.sub === "import") renderImport();
  else if (state.sub === "deleted") renderDeleted();
  else renderPartiesPage();
}

function tagHtml(category) {
  if (!category) return `<span class="note">―</span>`;
  const [bg, fg] = CATEGORY_COLORS[category] || ["#eee", "#333"];
  return `<span class="tag" style="background:${bg};color:${fg}">${esc(category)}</span>`;
}

function toolbarHtml(addLabel, total) {
  return `
    <div class="toolbar">
      <input type="search" id="q" placeholder="番号・名前・よみで絞り込み" value="${esc(state.q)}">
      <label><input type="checkbox" id="show-hidden" ${state.showHidden ? "checked" : ""}> 非表示も表示する</label>
      <button type="button" class="sub" id="btn-add">＋ ${esc(addLabel)}</button>
      <span class="count" id="count"></span>
    </div>`;
}

function bindToolbar(redraw, onAdd) {
  $("q").addEventListener("input", (e) => { state.q = e.target.value; redraw(); });
  $("show-hidden").addEventListener("change", (e) => { state.showHidden = e.target.checked; redraw(); });
  $("btn-add").addEventListener("click", onAdd);
}

// ----- 科目 -----
function renderAccountsPage() {
  const body = $("settings-body");
  if (state.accounts.length === 0) {
    body.innerHTML = `
      <div class="seedbox">
        <p><strong>科目がまだ登録されていません。</strong></p>
        <p>設計書の科目表（0〜99番）を、初期データとして入れます。入れたあとも、自由に変更できます。</p>
        <button type="button" class="primary" id="btn-seed">初期データを入れる（科目）</button>
      </div>`;
    $("btn-seed").addEventListener("click", seedAccounts);
    return;
  }
  body.innerHTML = toolbarHtml("科目を追加") + `
    <table class="list">
      <thead><tr>
        <th>No.</th><th>科目</th><th>区分</th><th>性質</th><th>よみ・略称</th><th>税率</th><th>事業/生活</th><th>備考</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>`;
  bindToolbar(drawAccountRows, () => openAccountDialog(null));
  $("tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openAccountDialog(state.accounts.find((a) => a.id === tr.dataset.id));
  });
  drawAccountRows();
}

function drawAccountRows() {
  const q = norm(state.q).trim();
  const rows = state.accounts.filter((a) => {
    if (a.hidden && !state.showHidden) return false;
    if (!q) return true;
    // 番号・よみ・略称は先頭が合えば、科目名は途中でも合えば出す
    return String(a.no).startsWith(q) ||
      norm(a.kana).split(/\s+/).some((w) => w.startsWith(q)) ||
      norm(a.name).includes(q);
  });
  $("tbody").innerHTML = rows.map((a) => {
    const blank = a.name.startsWith("（") || a.name === "ー";
    const cls = a.hidden ? "hidden-row" : blank ? "blank" : "";
    return `<tr data-id="${esc(a.id)}" class="${cls}">
      <td class="no">${esc(a.no)}</td>
      <td>${esc(a.name)}${a.hidden ? ' <span class="note">（非表示）</span>' : ""}</td>
      <td>${tagHtml(a.category)}</td>
      <td class="small">${esc(KIND_LABELS[a.kind] || "")}</td>
      <td class="small">${esc(a.kana)}</td>
      <td class="small">${a.tax ? esc(a.tax) + "%" : ""}</td>
      <td class="small">${a.kind === "revenue" || a.kind === "expense" ? (a.biz === "biz" ? "事業" : "生活") : ""}</td>
      <td class="small">${esc(a.note)}</td>
    </tr>`;
  }).join("");
  $("count").textContent = `${rows.length} 件 / 全${state.accounts.length}件`;
}

async function seedAccounts() {
  $("btn-seed").disabled = true;
  showError("");
  try {
    const batch = writeBatch(db);
    SEED_ACCOUNTS.forEach((a) => {
      const id = "acc_" + String(a.no).padStart(2, "0");
      batch.set(doc(col("accounts"), id), { ...a, createdAt: serverTimestamp() });
    });
    await batch.commit();
    await loadAll();
    renderAccountsPage();
  } catch (err) {
    showError("初期データの登録に失敗しました：" + err.code);
    $("btn-seed").disabled = false;
  }
}

function optionsHtml(list, selected) {
  return list.map(([v, label]) =>
    `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function openAccountDialog(acc) {
  const isNew = !acc;
  const a = acc || { no: "", name: "", kana: "", category: "経費", kind: "expense", note: "", tax: 0, biz: "life", hidden: false };
  $("modal").hidden = false;
  $("modal").innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>${isNew ? "科目を追加" : "科目を編集"}</h2>
      <div class="row">
        <div><label for="f-no">番号（0〜99）</label>
          <input type="number" id="f-no" min="0" max="99" value="${esc(a.no)}"></div>
        <div><label for="f-name">科目名</label>
          <input type="text" id="f-name" value="${esc(a.name)}"></div>
      </div>
      <label for="f-kana">よみ・略称（スペースで区切って複数登録できます）</label>
      <input type="text" id="f-kana" value="${esc(a.kana)}">
      <div class="row">
        <div><label for="f-cat">区分（B/S・P/Lでの表示場所）</label>
          <select id="f-cat"><option value="">（なし）</option>${optionsHtml(CATEGORIES.map((c) => [c, c]), a.category)}</select></div>
        <div><label for="f-kind">性質</label>
          <select id="f-kind">${optionsHtml(Object.entries(KIND_LABELS), a.kind)}</select></div>
      </div>
      <div class="row">
        <div><label for="f-tax">税率の初期値</label>
          <select id="f-tax">${optionsHtml([[0, "なし"], [8, "8%"], [10, "10%"]], a.tax)}</select></div>
        <div><label for="f-biz">事業/生活の初期値</label>
          <select id="f-biz">${optionsHtml([["life", "生活"], ["biz", "事業"]], a.biz)}</select></div>
      </div>
      <label for="f-note">備考</label>
      <input type="text" id="f-note" value="${esc(a.note)}">
      <label class="check"><input type="checkbox" id="f-hidden" ${a.hidden ? "checked" : ""}> 非表示にする（候補に出さない。削除はしません）</label>
      <div id="dlg-error" class="dlg-error" hidden></div>
      <div class="actions">
        <button type="button" class="sub" id="dlg-cancel">キャンセル</button>
        <button type="button" class="primary" id="dlg-save">保存</button>
      </div>
    </div>`;
  $("dlg-cancel").addEventListener("click", closeDialog);
  $("dlg-save").addEventListener("click", async () => {
    const no = parseInt($("f-no").value, 10);
    const name = $("f-name").value.trim();
    const fail = (m) => { $("dlg-error").textContent = m; $("dlg-error").hidden = false; };
    if (!Number.isInteger(no) || no < 0 || no > 99) return fail("番号は0〜99の整数で入れてください。");
    if (!name) return fail("科目名を入れてください。");
    if (state.accounts.some((x) => x.no === no && x.id !== (acc && acc.id))) {
      const o = state.accounts.find((x) => x.no === no);
      return fail(`番号${no}は「${o.name}」で使われています。別の番号にしてください。`);
    }
    const kind = $("f-kind").value;
    const data = {
      no, name,
      kana: $("f-kana").value.trim(),
      category: $("f-cat").value,
      kind,
      side: acc && acc.kind === kind && acc.side ? acc.side : sideOf(kind, no),
      note: $("f-note").value.trim(),
      tax: parseInt($("f-tax").value, 10),
      biz: $("f-biz").value,
      hidden: $("f-hidden").checked,
      updatedAt: serverTimestamp()
    };
    const id = acc ? acc.id : "acc_" + Date.now().toString(36);
    if (!acc) data.createdAt = serverTimestamp();
    $("dlg-save").disabled = true;
    try {
      await setDoc(doc(col("accounts"), id), data, { merge: true });
      await loadAll();
      closeDialog();
      renderAccountsPage();
    } catch (err) {
      $("dlg-save").disabled = false;
      fail("保存に失敗しました：" + err.code);
    }
  });
}

function closeDialog() {
  $("modal").hidden = true;
  $("modal").innerHTML = "";
}

// ----- 分野 -----
function renderFieldsPage() {
  const body = $("settings-body");
  if (state.fields.length === 0) {
    body.innerHTML = `
      <div class="seedbox">
        <p><strong>分野がまだ登録されていません。</strong></p>
        <p>設計書の分野（大分類7つ・約40分野）を、初期データとして入れます。入れたあとも、自由に変更できます。</p>
        <button type="button" class="primary" id="btn-seed">初期データを入れる（分野）</button>
      </div>`;
    $("btn-seed").addEventListener("click", seedFields);
    return;
  }
  body.innerHTML = toolbarHtml("分野を追加") + `
    <table class="list">
      <thead><tr><th>No.</th><th>分野</th><th>大分類</th><th>備考</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>`;
  bindToolbar(drawFieldRows, () => openFieldDialog(null));
  $("tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openFieldDialog(state.fields.find((f) => f.id === tr.dataset.id));
  });
  drawFieldRows();
}

function drawFieldRows() {
  const q = norm(state.q).trim();
  const rows = state.fields.filter((f) => {
    if (f.hidden && !state.showHidden) return false;
    if (!q) return true;
    return norm(`${f.no} ${f.name} ${f.majorName}`).includes(q);
  });
  $("tbody").innerHTML = rows.map((f) => `
    <tr data-id="${esc(f.id)}" class="${f.hidden ? "hidden-row" : ""}">
      <td class="no">${esc(f.no)}</td>
      <td>${esc(f.name)}${f.hidden ? ' <span class="note">（非表示）</span>' : ""}</td>
      <td class="small">${esc(f.majorNo)}番台 ${esc(f.majorName)}</td>
      <td class="small">${esc(f.note)}</td>
    </tr>`).join("");
  $("count").textContent = `${rows.length} 件 / 全${state.fields.length}件`;
}

async function seedFields() {
  $("btn-seed").disabled = true;
  showError("");
  try {
    const batch = writeBatch(db);
    SEED_FIELDS.forEach((f) => {
      const id = "fld_" + String(f.no).padStart(2, "0");
      batch.set(doc(col("fields"), id), { ...f, createdAt: serverTimestamp() });
    });
    await batch.commit();
    await loadAll();
    renderFieldsPage();
  } catch (err) {
    showError("初期データの登録に失敗しました：" + err.code);
    $("btn-seed").disabled = false;
  }
}

function openFieldDialog(fld) {
  const isNew = !fld;
  const f = fld || { no: "", name: "", majorNo: 10, majorName: "買い物", note: "", hidden: false };
  const majors = [];
  state.fields.forEach((x) => {
    if (!majors.some((m) => m[0] === x.majorNo)) majors.push([x.majorNo, `${x.majorNo}番台 ${x.majorName}`]);
  });
  majors.sort((a, b) => a[0] - b[0]);
  $("modal").hidden = false;
  $("modal").innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>${isNew ? "分野を追加" : "分野を編集"}</h2>
      <div class="row">
        <div><label for="g-no">番号（10〜99）</label>
          <input type="number" id="g-no" min="10" max="99" value="${esc(f.no)}"></div>
        <div><label for="g-name">分野名</label>
          <input type="text" id="g-name" value="${esc(f.name)}"></div>
      </div>
      <label for="g-major">大分類</label>
      <select id="g-major">${optionsHtml(majors, f.majorNo)}<option value="__new">（新しい大分類を作る）</option></select>
      <div id="g-newmajor" class="row" hidden>
        <div><label for="g-mno">大分類の番号（例：70）</label><input type="number" id="g-mno" min="10" max="90"></div>
        <div><label for="g-mname">大分類の名前</label><input type="text" id="g-mname"></div>
      </div>
      <label for="g-note">備考</label>
      <input type="text" id="g-note" value="${esc(f.note)}">
      <label class="check"><input type="checkbox" id="g-hidden" ${f.hidden ? "checked" : ""}> 非表示にする（候補に出さない。削除はしません）</label>
      <div id="dlg-error" class="dlg-error" hidden></div>
      <div class="actions">
        <button type="button" class="sub" id="dlg-cancel">キャンセル</button>
        <button type="button" class="primary" id="dlg-save">保存</button>
      </div>
    </div>`;
  $("g-major").addEventListener("change", (e) => { $("g-newmajor").hidden = e.target.value !== "__new"; });
  $("dlg-cancel").addEventListener("click", closeDialog);
  $("dlg-save").addEventListener("click", async () => {
    const fail = (m) => { $("dlg-error").textContent = m; $("dlg-error").hidden = false; };
    const no = parseInt($("g-no").value, 10);
    const name = $("g-name").value.trim();
    if (!Number.isInteger(no) || no < 10 || no > 99) return fail("番号は10〜99の整数で入れてください。");
    if (!name) return fail("分野名を入れてください。");
    if (state.fields.some((x) => x.no === no && x.id !== (fld && fld.id))) {
      const o = state.fields.find((x) => x.no === no);
      return fail(`番号${no}は「${o.name}」で使われています。別の番号にしてください。`);
    }
    let majorNo, majorName;
    if ($("g-major").value === "__new") {
      majorNo = parseInt($("g-mno").value, 10);
      majorName = $("g-mname").value.trim();
      if (!Number.isInteger(majorNo) || majorNo < 10 || majorNo > 90 || !majorName) {
        return fail("新しい大分類の番号と名前を入れてください。");
      }
    } else {
      majorNo = parseInt($("g-major").value, 10);
      majorName = (majors.find((m) => m[0] === majorNo) || [0, ""])[1].replace(/^\d+番台 /, "");
    }
    const data = { no, name, majorNo, majorName, note: $("g-note").value.trim(), hidden: $("g-hidden").checked, updatedAt: serverTimestamp() };
    const id = fld ? fld.id : "fld_" + Date.now().toString(36);
    if (!fld) data.createdAt = serverTimestamp();
    $("dlg-save").disabled = true;
    try {
      await setDoc(doc(col("fields"), id), data, { merge: true });
      await loadAll();
      closeDialog();
      renderFieldsPage();
    } catch (err) {
      $("dlg-save").disabled = false;
      fail("保存に失敗しました：" + err.code);
    }
  });
}


// ----- 取引先 -----
// スポット取引先：一度きりの店用に、店の種類だけを取引先にしたもの（設計書6章）
const SPOT_SEED = [
  ["pty_spot_ramen", "ラーメン屋", "らーめんや らーめん", "fld_22"],
  ["pty_spot_izakaya", "居酒屋", "いざかや", "fld_22"],
  ["pty_spot_teishoku", "定食屋", "ていしょくや", "fld_22"],
  ["pty_spot_other", "その他", "そのた", "fld_99"]
];

function renderPartiesPage() {
  const body = $("settings-body");
  const hasSpot = state.parties.some((p) => p.spot);
  body.innerHTML = `
    ${hasSpot ? "" : `<div class="seedbox">
      <p><strong>スポット取引先（一度きりの店用）がまだありません。</strong></p>
      <p>「ラーメン屋」「居酒屋」「定食屋」「その他」の4つを入れます。店名や食べたものは、摘要に書きます。あとから追加・変更できます。</p>
      <button type="button" class="primary" id="btn-seed">スポット取引先を入れる</button>
    </div>`}
    ${toolbarHtml("取引先を追加")}
    <table class="list">
      <thead><tr><th>取引先</th><th>種類</th><th>分野</th><th>よみ・略称</th><th>使用回数</th><th>最終利用</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <p class="note">取引先は記帳画面で名前を打つと、その場で登録されます。ここでは、よみ・略称、分野、スポットの印などを整えられます。</p>`;
  if (!hasSpot) $("btn-seed").addEventListener("click", seedSpots);
  bindToolbar(drawPartyRows, () => openPartyDialog(null));
  $("tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openPartyDialog(state.partiesById[tr.dataset.id]);
  });
  drawPartyRows();
}

function drawPartyRows() {
  const q = norm(state.q).trim();
  const rows = state.parties
    .filter((p) => {
      if (p.hidden && !state.showHidden) return false;
      if (!q) return true;
      return norm(p.name).includes(q) || norm(p.kana).split(/\s+/).some((w) => w.startsWith(q));
    })
    .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name), "ja"));
  $("tbody").innerHTML = rows.map((p) => `
    <tr data-id="${esc(p.id)}" class="${p.hidden ? "hidden-row" : ""}">
      <td>${esc(hk(p.name))}${p.hidden ? ' <span class="note">（非表示）</span>' : ""}</td>
      <td class="small">${p.spot ? '<span class="spot">スポット</span>' : ""}</td>
      <td class="small">${esc((p.fieldIds || []).map((id) => (state.fieldsById[id] ? hk(state.fieldsById[id].name) : "")).filter(Boolean).join("、"))}</td>
      <td class="small">${esc(p.kana)}</td>
      <td class="small" style="text-align:right">${esc(p.count || 0)}</td>
      <td class="small">${esc(p.lastUsed || "")}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="small" style="text-align:center;padding:20px">取引先はまだありません。</td></tr>`;
  $("count").textContent = `${rows.length} 件 / 全${state.parties.length}件`;
}

async function seedSpots() {
  $("btn-seed").disabled = true;
  showError("");
  try {
    const batch = writeBatch(db);
    SPOT_SEED.forEach(([id, name, kana, fid]) => {
      batch.set(doc(col("parties"), id), {
        name, kana, fieldIds: state.fieldsById[fid] ? [fid] : [], spot: true, hidden: false, count: 0,
        createdAt: serverTimestamp()
      }, { merge: true });
    });
    await batch.commit();
    await loadParties();
    renderPartiesPage();
  } catch (err) {
    showError("登録に失敗しました：" + err.code);
    $("btn-seed").disabled = false;
  }
}

function openPartyDialog(p) {
  const isNew = !p;
  const d = p || { name: "", kana: "", fieldIds: [], spot: false, hidden: false };
  const checks = state.fields.filter((f) => !f.hidden || (d.fieldIds || []).includes(f.id)).map((f) => `
    <label class="chk"><input type="checkbox" value="${esc(f.id)}" ${(d.fieldIds || []).includes(f.id) ? "checked" : ""}>
      <span class="num">${esc(f.no)}</span> ${esc(hk(f.name))}</label>`).join("");
  $("modal").hidden = false;
  $("modal").innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>${isNew ? "取引先を追加" : "取引先を編集"}</h2>
      <label for="p-name">取引先名</label>
      <input type="text" id="p-name" value="${esc(d.name)}">
      <label for="p-kana">よみ・略称（スペースで区切って複数登録できます）</label>
      <input type="text" id="p-kana" value="${esc(d.kana)}">
      <label>所属する分野（複数選べます。記帳で分野を選ぶと、その分野の取引先が上に出ます）</label>
      <div class="chkbox">${checks}</div>
      ${isNew ? "" : `<label>覚えている入力パターン（「削除」を押して、保存すると消えます）</label><div id="p-pats" class="patlist"></div>`}
      <label class="check"><input type="checkbox" id="p-spot" ${d.spot ? "checked" : ""}> スポット取引先（一度きりの店用。候補の一番下に出ます）</label>
      <label class="check"><input type="checkbox" id="p-hidden" ${d.hidden ? "checked" : ""}> 非表示にする（候補に出さない。削除はしません）</label>
      <div id="dlg-error" class="dlg-error" hidden></div>
      <div class="actions">
        <button type="button" class="sub" id="dlg-cancel">キャンセル</button>
        <button type="button" class="primary" id="dlg-save">保存</button>
      </div>
    </div>`;
  $("dlg-cancel").addEventListener("click", closeDialog);
  // 入力パターン：削除は、保存を押すまで確定しない
  let pats = p ? sortPatterns(patternsOf(p)) : [];
  let patsChanged = false;
  const drawPats = () => {
    const host = $("p-pats");
    if (!host) return;
    host.innerHTML = pats.length
      ? pats.map((pt, i) => `<div class="patrow"><span>${esc(describePattern(pt))}</span><span class="note">${esc(pt.uses || 0)}回</span>
          <button type="button" class="sub small" data-del="${i}">削除</button></div>`).join("")
      : `<p class="note">まだ覚えているパターンはありません。</p>`;
  };
  drawPats();
  if ($("p-pats")) $("p-pats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del]");
    if (!b) return;
    pats.splice(parseInt(b.dataset.del, 10), 1);
    patsChanged = true;
    drawPats();
  });
  $("dlg-save").addEventListener("click", async () => {
    const fail = (m) => { $("dlg-error").textContent = m; $("dlg-error").hidden = false; };
    const name = $("p-name").value.trim();
    if (!name) return fail("取引先名を入れてください。");
    if (state.parties.some((x) => norm(x.name) === norm(name) && x.id !== (p && p.id))) {
      return fail(`「${name}」は、すでに登録されています。`);
    }
    const fieldIds = [...document.querySelectorAll(".chkbox input:checked")].map((x) => x.value);
    const data = {
      name, kana: $("p-kana").value.trim(), fieldIds,
      spot: $("p-spot").checked, hidden: $("p-hidden").checked, updatedAt: serverTimestamp()
    };
    if (p && patsChanged) {
      data.patterns = pats.map((x) => ({ sig: x.sig, lines: x.lines, uses: x.uses || 0, last: x.last || "" }));
      data.last = deleteField();
    }
    const id = p ? p.id : "pty_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    if (!p) { data.createdAt = serverTimestamp(); data.count = 0; }
    $("dlg-save").disabled = true;
    try {
      await setDoc(doc(col("parties"), id), data, { merge: true });
      await loadParties();
      closeDialog();
      renderPartiesPage();
    } catch (err) {
      $("dlg-save").disabled = false;
      fail("保存に失敗しました：" + err.code);
    }
  });
}
