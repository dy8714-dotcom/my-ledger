// マイ帳簿サイト（ログインと、メニューの切り替え）
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { auth, state, loadAll, loadVouchers } from "./state.js?v=0.2I6d";
import { $, esc, showError } from "./util.js?v=0.2I6d";
import { renderSettings } from "./settings.js?v=0.2I6d";
import { renderEntry } from "./entry.js?v=0.2I6d";
import { renderTrial } from "./trial.js?v=0.2I6d";
import { renderLedger } from "./ledger.js?v=0.2I6d";
import { renderBS, renderPL } from "./statements.js?v=0.2I6d";
import { renderMonthEnd } from "./monthend.js?v=0.2I6d";
import { renderBackupBanner } from "./backup.js?v=0.2I6d";
import "./print.js?v=0.2I6d";

$("btn-login").addEventListener("click", async () => {
  showError("");
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    showError("ログインに失敗しました：" + err.code);
  }
});
$("btn-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  $("logged-out").hidden = !!user;
  $("nav").hidden = !user;
  $("view").hidden = !user;
  $("btn-logout").hidden = !user;
  $("user-email").textContent = user ? user.email : "";
  if (!user) { renderBackupBanner(); return; }
  try {
    await loadAll();
    await loadVouchers();
    render();
    renderBackupBanner();
  } catch (err) {
    showError("データの読み込みに失敗しました：" + err.code);
  }
});

$("nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  showError("");
  state.tab = b.dataset.tab;
  render();
});

function render() {
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === state.tab));
  if (state.tab === "entry") return renderEntry();
  if (state.tab === "trial") return renderTrial();
  if (state.tab === "bs") return renderBS();
  if (state.tab === "pl") return renderPL();
  if (state.tab === "ledger") return renderLedger();
  if (state.tab === "monthend") return renderMonthEnd();
  if (state.tab === "settings") return renderSettings();
  const names = { trial: "試算表", ledger: "元帳・検索" };
  $("view").innerHTML =
    `<div class="placeholder">「${esc(names[state.tab])}」は、このあとの手順で作ります。</div>`;
}
