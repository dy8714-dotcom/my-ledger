// マイ帳簿サイト v0.1（手順B：ログイン確認だけのページ）
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAQORPG1g5dnI5ZnhfCrzA6anI6bmvAs-U",
  authDomain: "my-ledger-3868d.firebaseapp.com",
  projectId: "my-ledger-3868d",
  storageBucket: "my-ledger-3868d.firebasestorage.app",
  messagingSenderId: "605358202997",
  appId: "1:605358202997:web:c5540f1a94217cf332183c"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
let currentUser = null;

function showError(msg) {
  const e = $("error");
  e.textContent = msg;
  e.hidden = !msg;
}

$("btn-login").addEventListener("click", async () => {
  showError("");
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    showError("ログインに失敗しました：" + err.code + "（" + err.message + "）");
  }
});

$("btn-logout").addEventListener("click", () => signOut(auth));

$("btn-copy-uid").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentUser.uid);
    $("btn-copy-uid").textContent = "コピーしました ✓";
    setTimeout(() => ($("btn-copy-uid").textContent = "UIDをコピー"), 2000);
  } catch (err) {
    showError("コピーできませんでした。UIDを選んで Ctrl＋C でコピーしてください。");
  }
});

$("btn-write").addEventListener("click", async () => {
  showError("");
  $("test-result").textContent = "書き込み中…";
  try {
    const now = new Date().toLocaleString("ja-JP");
    await setDoc(doc(db, "users", currentUser.uid, "test", "hello"), {
      text: "テスト書き込み " + now,
      at: serverTimestamp()
    });
    $("test-result").textContent = "書き込み成功 ✓（" + now + "）";
  } catch (err) {
    $("test-result").textContent = "";
    showError("書き込みに失敗しました：" + err.code + "（ルールを公開したか確認してください）");
  }
});

$("btn-read").addEventListener("click", async () => {
  showError("");
  $("test-result").textContent = "読み込み中…";
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid, "test", "hello"));
    $("test-result").textContent = snap.exists()
      ? "読み込み成功 ✓\n" + snap.data().text
      : "まだ書き込まれていません。先に「テスト書き込み」を押してください。";
  } catch (err) {
    $("test-result").textContent = "";
    showError("読み込みに失敗しました：" + err.code + "（ルールを公開したか確認してください）");
  }
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  $("logged-out").hidden = !!user;
  $("logged-in").hidden = !user;
  if (user) {
    $("user-email").textContent = user.email;
    $("user-uid").textContent = user.uid;
  }
});
