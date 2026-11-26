// 印刷の整備（I6d）：どの画面でも、ブラウザの「印刷」（Ctrl+P）でA4にきれいに出す
import { $ } from "./util.js?v=0.2I10c";
import { state } from "./state.js?v=0.2I10c";

const TAB = { entry: "記帳", trial: "試算表", bs: "B/S（貸借対照表）", pl: "P/L（損益計算書）", cf: "C/F（キャッシュフロー）", annual: "年間の表", breakdown: "貸借内訳", ledger: "元帳・検索", monthend: "月末", settings: "設定" };
let selOnly = false;

// 記帳画面：チェックを付けた仕訳だけを印刷する
export function printSelectedOnly() { selOnly = true; window.print(); }

function head() {
  let h = $("printhead");
  if (!h) {
    h = document.createElement("div");
    h.id = "printhead";
    $("view").parentNode.insertBefore(h, $("view"));
  }
  return h;
}

// 元帳は「行ごとの格子」なので、印刷のときだけ見出しが毎ページ付く表に作り替える
function ledgerTable() {
  const grid = $("lg-grid");
  if (!grid) return;
  const cells = (r) => [...r.children].map((c) => {
    const m = /span(\d)/.exec(c.className);
    return `<td class="${c.className.replace(/\bspan\d\b/g, "").trim()}"${m ? ` colspan="${m[1]}"` : ""}>${c.innerHTML}</td>`;
  }).join("");
  const rows = (id) => [...$(id).querySelectorAll(".lgr")].map((r) => `<tr class="${r.className.replace(/\b(lgr|lgh|alt)\b/g, "").trim()}">${cells(r)}</tr>`).join("");
  const empty = $("lg-body").querySelector(".lgempty");
  let box = $("lg-ptable");
  if (!box) {
    box = document.createElement("div");
    box.id = "lg-ptable";
    grid.parentNode.parentNode.insertBefore(box, grid.parentNode.nextSibling);
  }
  box.innerHTML = `<table class="ptbl"><thead>${rows("lg-head").replace(/<td/g, "<th").replace(/<\/td>/g, "</th>")}</thead>` +
    `<tbody>${rows("lg-body")}${rows("lg-foot")}</tbody></table>${empty ? `<p class="note">${empty.textContent}</p>` : ""}`;
}

function selectedOnly() {
  const body = $("vbody");
  if (!body) return;
  document.body.classList.add("printsel");
  let day = null, any = false;
  const flush = () => { if (day) day.classList.toggle("pnone", !any); };
  [...body.querySelectorAll("tr")].forEach((tr) => {
    if (tr.classList.contains("day")) { flush(); day = tr; any = false; }
    else if (tr.classList.contains("sel")) any = true;
  });
  flush();
}

window.addEventListener("beforeprint", () => {
  const view = $("view");
  view.dataset.tab = state.tab || "";
  const t = view.querySelector("h2");
  const sub = selOnly ? "（選んだ仕訳だけ）" : "";
  const d = new Date();
  const today = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  head().innerHTML = `<span><b>マイ帳簿サイト</b>　${TAB[state.tab] || ""}${t ? "　" + t.textContent : ""}${sub}</span><span>印刷日 ${today}</span>`;
  if (view.dataset.orient === "landscape" && state.tab === "annual") {
    // 年間の表は13列あるので、この表だけ A4 横向きにする
    let st = document.getElementById("print-orient");
    if (!st) { st = document.createElement("style"); st.id = "print-orient"; document.head.appendChild(st); }
    st.textContent = "@page { size: A4 landscape; margin: 10mm 8mm; }";
    // 行数が多いときは、1枚に収まるように縮小する（1行はおよそ3.4mm、使える高さはおよそ168mm）
    const tb = view.querySelector(".tbl.an");
    if (tb) {
      const R = tb.querySelectorAll("tbody tr").length;
      const z = Math.min(1, 168 / (R * 3.4 + 10));
      if (z < 1) { tb.style.zoom = z.toFixed(3); }
    }
  }
  if (state.tab === "ledger") ledgerTable();
  if (state.tab === "entry" && selOnly) selectedOnly();
});

window.addEventListener("afterprint", () => {
  const o = document.getElementById("print-orient");
  if (o) o.remove();
  const an = document.querySelector(".tbl.an");
  if (an) { an.style.zoom = ""; }
  selOnly = false;
  document.body.classList.remove("printsel");
  document.querySelectorAll("tr.pnone").forEach((tr) => tr.classList.remove("pnone"));
  const b = $("lg-ptable");
  if (b) b.innerHTML = "";
});
