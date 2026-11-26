// Googleドライブへのバックアップ保存（I5b）。このサイトが作ったファイルだけを扱う権限（drive.file）を使う
const CLIENT_ID = "705838323505-70a7vcqtous7hvpmh23t8arimevkj58j.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "マイ帳簿バックアップ";
export const KEEP_FILES = 30;
const PREFIX = "my-ledger-backup";

let gsiLoading = null;
function loadGsi() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gsiLoading) {
    gsiLoading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => res();
      s.onerror = () => { gsiLoading = null; rej(new Error("Googleの読み込みに失敗しました（通信やブロッカーを確認してください）")); };
      document.head.appendChild(s);
    });
  }
  return gsiLoading;
}

// 「許可」の小さな画面を出して、アクセストークンを受け取る（ボタンを押した直後に呼ぶ）
export async function requestToken() {
  await loadGsi();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (r) => (r && r.access_token ? resolve(r.access_token) : reject(new Error((r && (r.error_description || r.error)) || "許可が得られませんでした"))),
      error_callback: (e) => reject(new Error(e && e.type === "popup_closed" ? "許可の画面が閉じられました" : (e && (e.message || e.type)) || "許可が得られませんでした"))
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function api(token, url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: "Bearer " + token, ...(opt.headers || {}) } });
  if (!r.ok) {
    let m = "";
    try { m = (await r.json()).error.message; } catch (e) { /* 本文なし */ }
    throw new Error(`Googleドライブのエラー（${r.status}）${m ? "：" + m : ""}`);
  }
  return r.status === 204 ? null : r.json();
}

async function ensureFolder(token) {
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`);
  if (found.files && found.files.length) return found.files[0].id;
  const made = await api(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" })
  });
  return made.id;
}

async function upload(token, folderId, name, text) {
  const boundary = "mylb" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  return api(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body
  });
}

// フォルダ内の、このサイトが作ったバックアップのうち、新しい順に keep 件より古いものをごみ箱へ
export async function trimOld(token, folderId, keep = KEEP_FILES) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains '${PREFIX}'`);
  const list = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name)&pageSize=200`);
  const old = (list.files || []).slice(keep);
  for (const f of old) await api(token, `https://www.googleapis.com/drive/v3/files/${f.id}?fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  return old.length;
}

// token は requestToken() で受け取ったもの。makeText は、保存する文字列を作る関数
export async function saveToDrive(token, name, makeText) {
  const folderId = await ensureFolder(token);
  const text = await makeText();
  const file = await upload(token, folderId, name, text);
  let trimmed = 0;
  try { trimmed = await trimOld(token, folderId); } catch (err) { console.error("[ドライブ] 古いファイルの整理に失敗", err); }
  return { name: file.name, folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}`, trimmed, bytes: text.length };
}
