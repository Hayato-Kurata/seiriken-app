const express = require("express");
const QRCode = require("qrcode");
const path = require("path");

const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TOTAL_SEATS = 9;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "yubi2026";

// テーブル配置: 3テーブル × 3席
// A(左上): 席1,2,3  B(右上): 席4,5,6  C(右側): 席7,8,9
const TABLES = [
  { name: "A", seats: [1, 2, 3] },
  { name: "B", seats: [4, 5, 6] },
  { name: "C", seats: [7, 8, 9] },
];
// 隣接テーブル（A-B は横並び、B-C は角で接続）
const ADJACENT = { A: ["B"], B: ["A", "C"], C: ["B"] };

// スタッフ認証トークン管理
const adminTokens = new Set();

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// スタッフ認証ミドルウェア
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: "認証が必要です" });
  }
  next();
}

// --- データ管理 ---
const state = {};

function getToday() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDayState(date) {
  if (!state[date]) {
    // seats: { 1: null, 2: null, ... 9: null } — null=空き, ticketNumber=使用中
    const seats = {};
    for (let i = 1; i <= TOTAL_SEATS; i++) seats[i] = null;
    state[date] = {
      counter: 0,
      callingNumber: 0,
      seats,
      tickets: {},
      ticketsByNum: {},
    };
  }
  return state[date];
}

// 使用中の席数を算出
function getSeatsInUse(day) {
  return Object.values(day.seats).filter(v => v !== null).length;
}

// テーブルごとの空き席数
function getTableAvailability(day) {
  const result = {};
  for (const table of TABLES) {
    result[table.name] = table.seats.filter(s => day.seats[s] === null).length;
  }
  return result;
}

// 指定人数が座れる席を探す（同一テーブル優先、隣接テーブル結合も対応）
function findSeatsForGroup(day, people) {
  const avail = getTableAvailability(day);

  // 1〜3人: 同一テーブルに収まるか
  if (people <= 3) {
    for (const table of TABLES) {
      if (avail[table.name] >= people) {
        const emptySeats = table.seats.filter(s => day.seats[s] === null);
        return emptySeats.slice(0, people);
      }
    }
  }

  // 4〜6人: 隣接テーブル2つを結合
  if (people <= 6) {
    for (const table of TABLES) {
      for (const adjName of ADJACENT[table.name]) {
        const combined = avail[table.name] + avail[adjName];
        if (combined >= people) {
          const adjTable = TABLES.find(t => t.name === adjName);
          const seats1 = table.seats.filter(s => day.seats[s] === null);
          const seats2 = adjTable.seats.filter(s => day.seats[s] === null);
          return [...seats1, ...seats2].slice(0, people);
        }
      }
    }
  }

  // 7人以上: 全テーブルの空きを使う
  const allEmpty = [];
  for (const table of TABLES) {
    allEmpty.push(...table.seats.filter(s => day.seats[s] === null));
  }
  if (allEmpty.length >= people) {
    return allEmpty.slice(0, people);
  }

  return null; // 席が足りない
}

const MAX_SKIP = 3;

// 隣接席に座れる組を探す（スキップ上限も考慮）
function getNextFitting(day) {
  for (let i = 1; i <= day.counter; i++) {
    const t = day.ticketsByNum[i];
    if (!t || t.called) continue;

    // スキップされすぎた組は無条件で呼ぶ
    if ((t.skipped || 0) >= MAX_SKIP) {
      return { ticket: t, seats: findSeatsForGroup(day, t.people || 1) || [] };
    }

    const seats = findSeatsForGroup(day, t.people || 1);
    if (seats) {
      // この組より前の未呼び出し組のskipカウントを増やす
      for (let j = 1; j < i; j++) {
        const prev = day.ticketsByNum[j];
        if (prev && !prev.called) {
          const prevSeats = findSeatsForGroup(day, prev.people || 1);
          if (!prevSeats) {
            prev.skipped = (prev.skipped || 0) + 1;
          }
        }
      }
      return { ticket: t, seats };
    }
  }
  return null;
}

// --- API ---
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 整理券を取得
app.post("/api/ticket", (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { visitorId, people } = req.body;

  if (!visitorId) {
    return res.status(400).json({ error: "visitorId is required" });
  }

  day.counter++;
  const ticket = {
    number: day.counter,
    date: today,
    people: Math.min(Math.max(parseInt(people) || 1, 1), 9),
    issuedAt: new Date().toISOString(),
  };
  day.tickets[visitorId] = ticket;
  day.ticketsByNum[ticket.number] = ticket;

  res.json({ ticket, alreadyIssued: false });
});

// 自分のチケットの呼び出し状態を確認
app.get("/api/ticket-status/:number", (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const num = parseInt(req.params.number);
  const ticket = day.ticketsByNum[num];

  if (!ticket) {
    return res.json({ called: false, exists: false });
  }

  // 自分より前の未呼び出し人数を数える
  let aheadCount = 0;
  for (let i = 1; i < num; i++) {
    const t = day.ticketsByNum[i];
    if (t && !t.called) aheadCount++;
  }

  // 目安の集合時間を計算（現在時刻 + 待ち時間）
  const seats = Math.max(TOTAL_SEATS - getSeatsInUse(day), 1);
  const waitMinutes = Math.ceil(aheadCount / seats) * 20;
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const estimated = new Date(now.getTime() + waitMinutes * 60 * 1000);
  const estHH = String(estimated.getHours()).padStart(2, "0");
  const estMM = String(estimated.getMinutes()).padStart(2, "0");

  res.json({
    called: !!ticket.called,
    exists: true,
    aheadCount,
    estimatedTime: ticket.called ? null : `${estHH}:${estMM}`,
  });
});

// 現在の状況（来場者向け）
app.get("/api/status", (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  // 未呼び出しのチケット数を待ち人数とする
  let waiting = 0;
  for (let i = day.callingNumber + 1; i <= day.counter; i++) {
    const t = day.ticketsByNum[i];
    if (t && !t.called) waiting++;
  }
  const seatsInUse = getSeatsInUse(day);
  const availableSeats = Math.max(0, TOTAL_SEATS - seatsInUse);

  res.json({
    date: today,
    totalIssued: day.counter,
    callingNumber: day.callingNumber,
    seatsInUse,
    totalSeats: TOTAL_SEATS,
    availableSeats,
    waitingCount: waiting,
    tables: getTableAvailability(day),
    seats: { ...day.seats },
  });
});

// スタッフ: ログイン
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "パスワードが違います" });
  }
  const token = generateToken();
  adminTokens.add(token);
  res.json({ token });
});

// レスポンス用のステータスを生成
function makeAdminResponse(day, extra = {}) {
  const seatsInUse = getSeatsInUse(day);
  return {
    callingNumber: day.callingNumber,
    seatsInUse,
    totalIssued: day.counter,
    availableSeats: Math.max(0, TOTAL_SEATS - seatsInUse),
    tables: getTableAvailability(day),
    seats: { ...day.seats },
    ...extra,
  };
}

// 待ちの中から座れる組を呼び出す共通処理
function callFittingGroups(day) {
  const calledNumbers = [];
  let result;
  while ((result = getNextFitting(day))) {
    const { ticket, seats } = result;
    if (!seats || seats.length === 0) break;
    ticket.called = true;
    ticket.assignedSeats = seats;
    seats.forEach(s => day.seats[s] = ticket.number);
    day.callingNumber = Math.max(day.callingNumber, ticket.number);
    calledNumbers.push({ number: ticket.number, people: ticket.people || 1, seats });
  }
  return calledNumbers;
}

// スタッフ: 席が空いた → 隣接席を考慮して自動で次を呼び出す
app.post("/api/admin/release-seat", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { seatNumbers } = req.body;

  // 特定の席番号が指定された場合
  if (Array.isArray(seatNumbers)) {
    seatNumbers.forEach(s => {
      if (day.seats[s] !== null) day.seats[s] = null;
    });
  } else {
    // 従来互換: count指定で使用中の席を先頭から解放
    const count = Math.min(Math.max(parseInt(req.body.count) || 1, 1), TOTAL_SEATS);
    let released = 0;
    for (let i = 1; i <= TOTAL_SEATS && released < count; i++) {
      if (day.seats[i] !== null) {
        day.seats[i] = null;
        released++;
      }
    }
  }

  const calledNumbers = callFittingGroups(day);
  res.json(makeAdminResponse(day, { calledNumbers }));
});

// スタッフ: 座席を個別にON/OFF（開場時の直接案内用）
app.post("/api/admin/set-seat", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { seat, occupied } = req.body;

  if (seat >= 1 && seat <= TOTAL_SEATS) {
    day.seats[seat] = occupied ? "manual" : null;
  }

  res.json(makeAdminResponse(day));
});

// スタッフ: 座席数を一括調整（従来互換）
app.post("/api/admin/set-seats", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { seatsInUse } = req.body;
  const target = Math.max(0, Math.min(TOTAL_SEATS, seatsInUse || 0));
  const current = getSeatsInUse(day);

  if (target > current) {
    let added = 0;
    for (let i = 1; i <= TOTAL_SEATS && added < target - current; i++) {
      if (day.seats[i] === null) { day.seats[i] = "manual"; added++; }
    }
  } else if (target < current) {
    let removed = 0;
    for (let i = TOTAL_SEATS; i >= 1 && removed < current - target; i--) {
      if (day.seats[i] !== null) { day.seats[i] = null; removed++; }
    }
  }

  res.json(makeAdminResponse(day));
});

// スタッフ: 手動で整理券発行（スマホ使えない人用）
app.post("/api/admin/manual-issue", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const people = Math.min(Math.max(parseInt(req.body.people) || 1, 1), 9);

  day.counter++;
  const ticket = {
    number: day.counter,
    date: today,
    people,
    issuedAt: new Date().toISOString(),
    manual: true,
  };
  day.ticketsByNum[ticket.number] = ticket;

  res.json({ ticket });
});

// スタッフ: 不在スキップ
app.post("/api/admin/skip", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { number } = req.body;
  const ticket = day.ticketsByNum[number];

  if (ticket && ticket.called) {
    ticket.skippedNoShow = true;
    // その人が使っていた席を解放
    if (ticket.assignedSeats) {
      ticket.assignedSeats.forEach(s => day.seats[s] = null);
    }
    const calledNumbers = callFittingGroups(day);
    return res.json(makeAdminResponse(day, { skipped: number, calledNumbers }));
  }

  res.json({ error: "該当チケットなし" });
});

// QRコード生成
app.get("/api/qrcode", async (req, res) => {
  const baseUrl = req.query.url || `${req.protocol}://${req.get("host")}`;
  try {
    const dataUrl = await QRCode.toDataURL(baseUrl, {
      width: 400,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    res.json({ qr: dataUrl, url: baseUrl });
  } catch (err) {
    res.status(500).json({ error: "QR生成失敗" });
  }
});

app.listen(PORT, () => {
  console.log(`整理券アプリ起動: http://localhost:${PORT}`);
  console.log(`スタッフ画面: http://localhost:${PORT}/admin.html`);

  // Renderスリープ防止: 14分ごとに自己ping
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      fetch(`${process.env.RENDER_EXTERNAL_URL}/api/status`).catch(() => {});
    }, 14 * 60 * 1000);
  }
});
