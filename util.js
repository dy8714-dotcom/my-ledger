// 共通の小さな道具
import { CATEGORY_COLORS } from "./seed.js?v=0.1D5";

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 検索用：半角・全角、ひらがな・カタカナ、大文字・小文字を区別しない
export function norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// 表示用：全角カタカナを半角カナにする（濁点・半濁点は別の1文字になる）
const HK = {
  "ア": "ｱ", "イ": "ｲ", "ウ": "ｳ", "エ": "ｴ", "オ": "ｵ", "カ": "ｶ", "キ": "ｷ", "ク": "ｸ", "ケ": "ｹ", "コ": "ｺ",
  "サ": "ｻ", "シ": "ｼ", "ス": "ｽ", "セ": "ｾ", "ソ": "ｿ", "タ": "ﾀ", "チ": "ﾁ", "ツ": "ﾂ", "テ": "ﾃ", "ト": "ﾄ",
  "ナ": "ﾅ", "ニ": "ﾆ", "ヌ": "ﾇ", "ネ": "ﾈ", "ノ": "ﾉ", "ハ": "ﾊ", "ヒ": "ﾋ", "フ": "ﾌ", "ヘ": "ﾍ", "ホ": "ﾎ",
  "マ": "ﾏ", "ミ": "ﾐ", "ム": "ﾑ", "メ": "ﾒ", "モ": "ﾓ", "ヤ": "ﾔ", "ユ": "ﾕ", "ヨ": "ﾖ",
  "ラ": "ﾗ", "リ": "ﾘ", "ル": "ﾙ", "レ": "ﾚ", "ロ": "ﾛ", "ワ": "ﾜ", "ヲ": "ｦ", "ン": "ﾝ",
  "ァ": "ｧ", "ィ": "ｨ", "ゥ": "ｩ", "ェ": "ｪ", "ォ": "ｫ", "ッ": "ｯ", "ャ": "ｬ", "ュ": "ｭ", "ョ": "ｮ",
  "ー": "ｰ", "・": "･", "、": "､", "。": "｡", "「": "｢", "」": "｣",
  "゙": "ﾞ", "゚": "ﾟ"
};
export function hk(s) {
  let out = "";
  for (const c of String(s ?? "")) {
    if ((c >= "ァ" && c <= "ー") || "・、。「」".includes(c)) {
      out += [...c.normalize("NFD")].map((x) => HK[x] ?? x).join("");
    } else {
      out += c;
    }
  }
  return out;
}

export const yen = (n) => Number(n).toLocaleString("ja-JP");

// 金額の入力：全角数字やカンマ、円マークがあっても読み取る。数字以外は NaN
export function parseAmount(s) {
  const t = String(s ?? "").normalize("NFKC").replace(/[,，\s¥円]/g, "");
  return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

export const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "2026-11-24" → "26.11"
export function monthOf(dateStr) {
  return dateStr.slice(2, 4) + "." + parseInt(dateStr.slice(5, 7), 10);
}

// "26.12" に +1 → "27.1"
export function shiftMonth(m, delta) {
  const [yy, mm] = m.split(".").map((x) => parseInt(x, 10));
  const idx = (2000 + yy) * 12 + (mm - 1) + delta;
  const y = Math.floor(idx / 12);
  return String(y).slice(2) + "." + ((idx % 12) + 1);
}

export function firstDayOf(m) {
  const [yy, mm] = m.split(".");
  return `20${yy}-${mm.padStart(2, "0")}-01`;
}

export function accChip(acc) {
  const [bg, fg] = CATEGORY_COLORS[acc.category] || ["#eee", "#333"];
  return `<span class="ac" style="background:${bg};color:${fg}"><b>${esc(acc.no)}</b>${esc(acc.name)}</span>`;
}

export function showError(msg) {
  const e = $("error");
  e.textContent = msg || "";
  e.hidden = !msg;
}

export function openModal(html) {
  $("modal").innerHTML = html;
  $("modal").hidden = false;
}

export function closeModal() {
  $("modal").hidden = true;
  $("modal").innerHTML = "";
}
