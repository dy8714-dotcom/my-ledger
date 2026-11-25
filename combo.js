// 入力欄＋候補の一覧（番号・よみ・文字で絞り込み）
import { esc, norm } from "./util.js?v=0.1H2";

// 小さいほど上に出す。-1は候補に出さない
function score(item, q) {
  if (!q) return 5;
  if (item.no != null) {
    const n = String(item.no);
    if (n === q) return 0;
    if (/^\d+$/.test(q) && n.startsWith(q)) return 1;
  }
  const words = norm(item.kana).split(/\s+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 2;
  const nm = norm(item.name);
  if (nm.startsWith(q)) return 3;
  if (nm.includes(q)) return 4;
  return -1;
}

export function rank(items, q) {
  return items
    .map((it) => ({ it, s: score(it, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) =>
      a.s - b.s ||
      (b.it.boost ? 1 : 0) - (a.it.boost ? 1 : 0) ||
      (a.it.spot ? 1 : 0) - (b.it.spot ? 1 : 0) ||
      (b.it.count || 0) - (a.it.count || 0) ||
      (a.it.no ?? 1e9) - (b.it.no ?? 1e9) ||
      String(a.it.name).localeCompare(String(b.it.name), "ja"))
    .map((x) => x.it);
}

// host: 中身を作る枠の要素
// opts: { getItems(), labelOf(id), allowNew, onChange(value), onEnter() }
export function createCombo(host, opts) {
  host.classList.add("combo");
  host.innerHTML = `<input type="text" autocomplete="off" spellcheck="false"><div class="combo-list" hidden></div>`;
  const input = host.querySelector("input");
  const listEl = host.querySelector(".combo-list");
  let selId = null;
  let newName = null;
  let open = false;
  let hi = 0;
  let typed = false;
  let shown = [];

  const labelNow = () => (selId ? opts.labelOf(selId) : newName || "");

  function restore() {
    input.value = labelNow();
    typed = false;
  }

  function compute() {
    const q = typed ? norm(input.value).trim() : "";
    const all = opts.getItems();
    shown = rank(all, q).slice(0, 80).map((item) => ({ item }));
    if (opts.allowNew && typed && input.value.trim() && !all.some((it) => norm(it.name) === q)) {
      shown.push({ isNew: true, text: input.value.trim() });
    }
    hi = 0;
  }

  function draw() {
    if (shown.length === 0) {
      listEl.innerHTML = `<div class="opt none">候補がありません</div>`;
      return;
    }
    listEl.innerHTML = shown.map((s, i) => {
      const cls = "opt" + (i === hi ? " hi" : "") + (s.isNew ? " new" : "");
      return s.isNew
        ? `<div class="${cls}" data-i="${i}">＋「${esc(s.text)}」を新規登録</div>`
        : `<div class="${cls}" data-i="${i}">${s.item.html}</div>`;
    }).join("");
    const el = listEl.children[hi];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  function openList() {
    compute();
    draw();
    listEl.hidden = false;
    open = true;
  }

  function closeList() {
    listEl.hidden = true;
    open = false;
  }

  function choose(i) {
    const s = shown[i];
    if (!s) return;
    if (s.isNew) { selId = null; newName = s.text; } else { selId = s.item.id; newName = null; }
    typed = false;
    input.value = labelNow();
    closeList();
    if (opts.onChange) opts.onChange(api.getValue());
  }

  input.addEventListener("focus", () => { input.select(); openList(); });
  input.addEventListener("input", () => { typed = true; openList(); });
  input.addEventListener("blur", () => { closeList(); restore(); });
  input.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openList(); return; }
      hi = Math.max(0, Math.min(shown.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && shown.length && (typed || !labelNow())) choose(hi);
      closeList();
      if (opts.onEnter) opts.onEnter();
    } else if (e.key === "Tab") {
      if (open && typed && shown.length) choose(hi);
    } else if (e.key === "Escape") {
      restore();
      closeList();
    }
  });
  listEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const o = e.target.closest(".opt[data-i]");
    if (o) choose(parseInt(o.dataset.i, 10));
  });

  const api = {
    input,
    getValue: () => ({ id: selId, newName }),
    setValue(id) { selId = id || null; newName = null; restore(); },
    clear() { selId = null; newName = null; restore(); },
    focus() { input.focus(); },
    isEmpty: () => !selId && !newName
  };
  return api;
}
