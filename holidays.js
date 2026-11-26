// 日本の祝日・休みの計算（サイトの中だけで計算する）。振替休日・国民の休日・春分秋分を含む
const pad = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const nthMon = (y, m, n) => { const first = dow(y, m, 1); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
const equinox = (y, base) => Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

const cache = {};
function baseHolidays(y) {
  const h = {};
  const add = (m, d, name) => { h[key(y, m, d)] = name; };
  add(1, 1, "元日");
  if (y >= 2000) add(1, nthMon(y, 1, 2), "成人の日"); else add(1, 15, "成人の日");
  if (y >= 1967) add(2, 11, "建国記念の日");
  if (y >= 2020) add(2, 23, "天皇誕生日");
  add(3, equinox(y, 20.8431), "春分の日");
  add(4, 29, y >= 2007 ? "昭和の日" : "みどりの日");
  add(5, 3, "憲法記念日"); add(5, 5, "こどもの日");
  if (y >= 2007) add(5, 4, "みどりの日");
  if (y === 2020) add(7, 23, "海の日"); else if (y === 2021) add(7, 22, "海の日"); else if (y >= 2003) add(7, nthMon(y, 7, 3), "海の日");
  if (y === 2020) add(7, 24, "スポーツの日"); else if (y === 2021) add(7, 23, "スポーツの日");
  if (y === 2020) add(8, 10, "山の日"); else if (y === 2021) add(8, 8, "山の日"); else if (y >= 2016) add(8, 11, "山の日");
  if (y >= 2003) add(9, nthMon(y, 9, 3), "敬老の日"); else add(9, 15, "敬老の日");
  add(9, equinox(y, 23.2488), "秋分の日");
  if (y >= 2022) add(10, nthMon(y, 10, 2), "スポーツの日"); else if (y !== 2020 && y !== 2021) add(10, y >= 2000 ? nthMon(y, 10, 2) : 10, "体育の日");
  add(11, 3, "文化の日"); add(11, 23, "勤労感謝の日");
  if (y < 2020 && y >= 1989) add(12, 23, "天皇誕生日");
  return h;
}

function holidaysOf(y) {
  if (cache[y]) return cache[y];
  const h = { ...baseHolidays(y) };
  const days = Object.keys(h).sort();
  // 振替休日：日曜と重なった祝日の次の、祝日でない日
  days.forEach((k) => {
    const [yy, mm, dd] = k.split("-").map(Number);
    if (dow(yy, mm, dd) !== 0) return;
    let t = new Date(Date.UTC(yy, mm - 1, dd + 1));
    for (;;) {
      const kk = key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
      if (!h[kk]) { h[kk] = "振替休日"; break; }
      t = new Date(t.getTime() + 86400000);
    }
  });
  // 国民の休日：前後が祝日にはさまれた平日
  for (let m = 1; m <= 12; m++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 2; d < last; d++) {
      const k = key(y, m, d);
      if (h[k] || dow(y, m, d) === 0) continue;
      if (h[key(y, m, d - 1)] && h[key(y, m, d + 1)]) h[k] = "国民の休日";
    }
  }
  cache[y] = h;
  return h;
}

export function holidayName(date) {
  const [y] = date.split("-").map(Number);
  return holidaysOf(y)[date] || "";
}

// 年末年始（12/29〜1/3）は、銀行が休みなので、休みとして数える
export function isYearEnd(date) {
  const m = parseInt(date.slice(5, 7), 10), d = parseInt(date.slice(8, 10), 10);
  return (m === 12 && d >= 29) || (m === 1 && d <= 3);
}

// 休みの理由（平日なら空）
export function offReason(date) {
  const [y, m, d] = date.split("-").map(Number);
  const w = dow(y, m, d);
  if (w === 6) return "土曜";
  if (w === 0) return "日曜";
  if (holidayName(date)) return "祝日";
  if (isYearEnd(date)) return "年末年始";
  return "";
}

// dir: "next"（次の平日）／ "prev"（前の平日）／ それ以外は、そのまま
export function shiftBusiness(date, dir) {
  if (dir !== "next" && dir !== "prev") return date;
  let t = Date.UTC(...date.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  const step = dir === "next" ? 86400000 : -86400000;
  for (let i = 0; i < 20; i++) {
    const dt = new Date(t);
    const k = key(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (!offReason(k)) return k;
    t += step;
  }
  return date;
}
