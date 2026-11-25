// 共有の状態と、Firestoreの読み込み
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where }
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
  showHidden: false
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

export async function loadAll() {
  const [a, f] = await Promise.all([getDocs(col("accounts")), getDocs(col("fields"))]);
  state.accounts = toList(a).sort((x, y) => x.no - y.no);
  state.accountsById = byId(state.accounts);
  state.fields = toList(f).sort((x, y) => x.no - y.no);
  state.fieldsById = byId(state.fields);
  await loadParties();
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
  state.vouchers = await fetchMonthVouchers(state.month);
}
