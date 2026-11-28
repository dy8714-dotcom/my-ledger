// マイ帳簿サイト（ログインと、メニューの切り替え）
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { auth, state, loadAll, loadVouchers } from "./state.js?v=0.2I11e";
import { $, esc, showError } from "./util.js?v=0.2I11e";
import { renderSettings } from "./settings.js?v=0.2I11e";
import { renderEntry } from "./entry.js?v=0.2I11e";
import { renderTrial } from "./trial.js?v=0.2I11e";
import { renderLedger } from "./ledger.js?v=0.2I11e";
import { renderBS, renderPL } from "./statements.js?v=0.2I11e";
import { renderCF } from "./cashflow.js?v=0.2I11e";
import { renderAnnual } from "./annual.js?v=0.2I11e";
import { renderBreakdown, refreshHeaderCheck } from "./breakdown.js?v=0.2I11e";
import { renderMonthEnd } from "./monthend.js?v=0.2I11e";
import { renderSalary } from "./salary.js?v=0.2I11e";
import { renderBackupBanner } from "./backup.js?v=0.2I11e";
import "./print.js?v=0.2I11e";

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

$("hdr-check").addEventListener("click", () => { if (state.user) document.querySelector('#nav [data-tab="breakdown"]').click(); });

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
  const fn = { entry: renderEntry, trial: renderTrial, bs: renderBS, pl: renderPL, cf: renderCF, annual: renderAnnual, breakdown: renderBreakdown, ledger: renderLedger, monthend: renderMonthEnd, salary: renderSalary, settings: renderSettings }[state.tab];
  if (fn) {
    refreshHeaderCheck();
    return Promise.resolve(fn()).then(() => refreshHeaderCheck(), () => {});
  }
  const names = { trial: "試算表", ledger: "元帳・検索" };
  $("view").innerHTML =
    `<div class="placeholder">「${esc(names[state.tab])}」は、このあとの手順で作ります。</div>`;
}
