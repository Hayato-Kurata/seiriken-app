const express = require("express");
const QRCode = require("qrcode");
const path = require("path");

const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TOTAL_SEATS = 9;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "yubi2026";

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
    state[date] = {
      counter: 0,
      callingNumber: 0,
      seatsInUse: 0,
      tickets: {},
    };
  }
  return state[date];
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

  // 既に取得済みならそれを返す
  if (day.tickets[visitorId]) {
    return res.json({ ticket: day.tickets[visitorId], alreadyIssued: true });
  }

  day.counter++;
  const ticket = {
    number: day.counter,
    date: today,
    people: Math.min(Math.max(parseInt(people) || 1, 1), 9),
    issuedAt: new Date().toISOString(),
  };
  day.tickets[visitorId] = ticket;

  res.json({ ticket, alreadyIssued: false });
});

// 現在の状況（来場者向け）
app.get("/api/status", (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const waiting = Math.max(0, day.counter - day.callingNumber);
  const availableSeats = Math.max(0, TOTAL_SEATS - day.seatsInUse);

  res.json({
    date: today,
    totalIssued: day.counter,
    callingNumber: day.callingNumber,
    seatsInUse: day.seatsInUse,
    totalSeats: TOTAL_SEATS,
    availableSeats,
    waitingCount: waiting,
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

// スタッフ: 次の番号を呼び出す
app.post("/api/admin/call-next", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);

  if (day.callingNumber < day.counter) {
    day.callingNumber++;
    if (day.seatsInUse < TOTAL_SEATS) {
      day.seatsInUse++;
    }
  }

  res.json({
    callingNumber: day.callingNumber,
    seatsInUse: day.seatsInUse,
    totalIssued: day.counter,
    availableSeats: Math.max(0, TOTAL_SEATS - day.seatsInUse),
  });
});

// スタッフ: 席が空いた → 自動で次の番号を呼び出す
app.post("/api/admin/release-seat", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const count = Math.min(Math.max(parseInt(req.body.count) || 1, 1), TOTAL_SEATS);
  const calledNumbers = [];

  for (let i = 0; i < count; i++) {
    if (day.seatsInUse > 0) {
      day.seatsInUse--;
    }
    // 待ちがいれば自動で次を呼び出し
    if (day.callingNumber < day.counter) {
      day.callingNumber++;
      day.seatsInUse++;
      calledNumbers.push(day.callingNumber);
    }
  }

  res.json({
    callingNumber: day.callingNumber,
    seatsInUse: day.seatsInUse,
    totalIssued: day.counter,
    availableSeats: Math.max(0, TOTAL_SEATS - day.seatsInUse),
    calledNumbers,
  });
});

// スタッフ: 座席数を手動調整
app.post("/api/admin/set-seats", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { seatsInUse } = req.body;

  if (typeof seatsInUse === "number" && seatsInUse >= 0 && seatsInUse <= TOTAL_SEATS) {
    day.seatsInUse = seatsInUse;
  }

  res.json({
    callingNumber: day.callingNumber,
    seatsInUse: day.seatsInUse,
    totalIssued: day.counter,
    availableSeats: Math.max(0, TOTAL_SEATS - day.seatsInUse),
  });
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
});
