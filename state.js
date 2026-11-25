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
  lg: null,
  savedSearches: null,
  tb: { month: null, mode: "month", from: null, to: null, hideZero: true, byNo: false }
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

export async function loadAll() {
  const [a, f] = await Promise.all([getDocs(col("accounts")), getDocs(col("fields"))]);
  state.accounts = toList(a).sort((x, y) => x.no - y.no);
  state.accountsById = byId(state.accounts);
  state.fields = toList(f).sort((x, y) => x.no - y.no);
  state.fieldsById = byId(state.fields);
  await loadParties();
  await loadStats();
}

function sortVouchers(list) {
  return list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.seq - y.seq));
}

// 指定した月度の仕訳を取ってくる
export async function fetchMonthVouchers(month) {
  const snap = await getDocs(query(col("vouchers"), where("month", "==", month)));
  return sortVouchers(toList(snap));
}

// 画面で表示中の月度の仕訳を読み直す
export async function loadVouchers() {
  state.allVouchers = null; // 記帳・削除のあと、試算表用の全件は読み直す
  state.vouchers = await fetchMonthVouchers(state.month);
}

// 試算表用：全期間の仕訳（画面を開いている間は使い回す）
export async function loadAllVouchers() {
  if (!state.allVouchers) state.allVouchers = toList(await getDocs(col("vouchers")));
  return state.allVouchers;
}
