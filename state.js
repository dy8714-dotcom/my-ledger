// 共有の状態と、Firestoreの読み込み
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, collection, getDocs, getDoc, doc, query, where }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAQORPG1g5dnI5ZnhfCrzA6anI6bmvAs-U",
  authDomain: "my-ledger-3868d.firebaseapp.com",
  projectId: "my-ledger-3868d",
  storageBucket: "my-ledger-3868d.firebasestorage.app",
  messagingSenderId: "605358202997",
  appId: "1:605358202997:web:c5540f1a94217cf332183c"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 今日の月度（例：2026年11月 → "26.11"）
function currentMonth() {
  const d = new Date();
  return String(d.getFullYear()).slice(2) + "." + (d.getMonth() + 1);
}

export const state = {
  user: null,
  tab: "entry",
  sub: "accounts",
  accounts: [],
  accountsById: {},
  fields: [],
  fieldsById: {},
  parties: [],
  partiesById: {},
  vouchers: [],
  month: currentMonth(),
  lastDate: null,
  q: "",
  showHidden: false,
  stats: { accField: {}, fieldParty: {} },
  allVouchers: null,
  assets: [],
  closings: [],
  recurring: [],
  lg: null,
  savedSearches: null,
  lastBackupAt: null,
  lastDriveAt: null,
  backupSnoozed: false,
  st: { month: null, cmp: "prev", cmpMonth: null, scope: "all" },
  tb: { month: null, mode: "month", from: null, to: null, hideZero: true, byNo: false, scope: "all" }
};

export function col(name) {
  return collection(db, "users", state.user.uid, name);
}

function toList(snap) {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function byId(list) {
  const m = {};
  list.forEach((x) => { m[x.id] = x; });
  return m;
}

export async function loadParties() {
  state.parties = toList(await getDocs(col("parties")));
  state.partiesById = byId(state.parties);
}

// 学習の回数（科目×分野、分野×取引先）
export async function loadStats() {
  try {
    const snap = await getDoc(doc(col("meta"), "stats"));
    const d = snap.exists() ? snap.data() : {};
    state.stats = { accField: d.accField || {}, fieldParty: d.fieldParty || {} };
  } catch (err) {
    state.stats = { accField: {}, fieldParty: {} };
  }
}

// 削除済みの仕訳（設定の「削除した仕訳」用）
export async function loadDeletedVouchers() {
  const snap = await getDocs(query(col("vouchers"), where("deleted", "==", true)));
  return sortVouchers(toList(snap)).reverse();
}

// 最後にバックアップを保存した日時
export async function loadBackupInfo() {
  try {
    const snap = await getDoc(doc(col("meta"), "backup"));
    state.lastBackupAt = snap.exists() ? snap.data().lastAt || null : null;
    state.lastDriveAt = snap.exists() ? snap.data().driveAt || null : null;
  } catch (err) { state.lastBackupAt = null; }
}

// 期首の内訳（貸借内訳の期首分。meta/openings に {items:[{key, partyId, label, amount}]}）
export async function loadOpenings() {
  const snap = await getDoc(doc(col("meta"), "openings"));
  state.openings = snap.exists() ? snap.data().items || [] : [];
  return state.openings;
}

export async function loadAssets() {
  state.assets = toList(await getDocs(col("assets"))).sort((x, y) => (x.acquiredDate || "") < (y.acquiredDate || "") ? -1 : 1);
  return state.assets;
}

export async function loadClosings() {
  state.closings = toList(await getDocs(col("closings")));
  return state.closings;
}
export async function loadRecurring() {
  state.recurring = toList(await getDocs(col("recurring"))).sort((x, y) => (x.day || 0) - (y.day || 0) || String(x.name || "").localeCompare(String(y.name || ""), "ja"));
  return state.recurring;
}
// 締めた月かどうか
export const isClosed = (month) => (state.closings || []).some((c) => c.month === month && c.status === "closed");

export async function loadAll() {
  const [a, f] = await Promise.all([getDocs(col("accounts")), getDocs(col("fields"))]);
  state.accounts = toList(a).sort((x, y) => x.no - y.no);
  state.accountsById = byId(state.accounts);
  state.fields = toList(f).sort((x, y) => x.no - y.no);
  state.fieldsById = byId(state.fields);
  await loadParties();
  await loadStats();
  await loadBackupInfo();
  try { await loadClosings(); } catch (err) { console.error("[月次締め] 読み込み失敗", err); state.closings = []; }
  try { await loadRecurring(); } catch (err) { console.error("[定期支払] 読み込み失敗", err); state.recurring = []; }
  try { await loadOpenings(); } catch (err) { console.error("[期首の内訳] 読み込み失敗", err); state.openings = []; }
  try { await loadAssets(); } catch (err) { console.error("[月割り償却] 読み込み失敗", err); state.assets = []; }
}

const DAY = 24 * 60 * 60 * 1000;
export const RESTORE_DAYS = 30; // 削除した仕訳を戻せる日数

// 「削除済み」を除いた一覧にする。伝番は使い回さないので、削除済みを含む最大の連番を覚えておく
function liveList(list) {
  const live = list.filter((v) => !v.deleted);
  live.maxSeqAll = list.reduce((m, v) => Math.max(m, v.seq || 0), 0);
  return live;
}

function sortVouchers(list) {
  return list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.seq - y.seq));
}

// 指定した月度の仕訳を取ってくる
export async function fetchMonthVouchers(month) {
  const snap = await getDocs(query(col("vouchers"), where("month", "==", month)));
  return liveList(sortVouchers(toList(snap)));
}

// 画面で表示中の月度の仕訳を読み直す
export async function loadVouchers() {
  state.allVouchers = null; // 記帳・削除のあと、試算表用の全件は読み直す
  state.vouchers = await fetchMonthVouchers(state.month);
}

// 試算表用：全期間の仕訳（画面を開いている間は使い回す）
export async function loadAllVouchers() {
  if (!state.allVouchers) state.allVouchers = toList(await getDocs(col("vouchers"))).filter((v) => !v.deleted);
  return state.allVouchers;
}
