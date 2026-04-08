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
      tickets: {},       // visitorId -> ticket
      ticketsByNum: {},   // number -> ticket
    };
  }
  return state[date];
}

const MAX_SKIP = 3; // これ以上スキップされたら席数に関わらず優先呼び出し

// まだ呼ばれていないチケットのうち、空き席に収まる組を探す
// ただしMAX_SKIP回以上スキップされた組は最優先で呼ぶ
function getNextFitting(day, availableSeats) {
  let firstWaiting = null;

  for (let i = 1; i <= day.counter; i++) {
    const t = day.ticketsByNum[i];
    if (!t || t.called) continue;

    // スキップされすぎた組は無条件で呼ぶ
    if ((t.skipped || 0) >= MAX_SKIP) {
      return t;
    }

    if (!firstWaiting) firstWaiting = t;

    if ((t.people || 1) <= availableSeats) {
      // この組より前にいる未呼び出し組のskipカウントを増やす
      for (let j = 1; j < i; j++) {
        const prev = day.ticketsByNum[j];
        if (prev && !prev.called && (prev.people || 1) > availableSeats) {
          prev.skipped = (prev.skipped || 0) + 1;
        }
      }
      return t;
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
  const seats = Math.max(TOTAL_SEATS - day.seatsInUse, 1);
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

// スタッフ: 次の番号を呼び出す（初期呼び出し用）
app.post("/api/admin/call-next", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const next = getNextFitting(day, TOTAL_SEATS - day.seatsInUse);

  if (next) {
    next.called = true;
    day.callingNumber = Math.max(day.callingNumber, next.number);
    day.seatsInUse += (next.people || 1);
  }

  res.json({
    callingNumber: day.callingNumber,
    seatsInUse: day.seatsInUse,
    totalIssued: day.counter,
    availableSeats: Math.max(0, TOTAL_SEATS - day.seatsInUse),
  });
});

// スタッフ: 席が空いた → 人数を考慮して自動で次を呼び出す
app.post("/api/admin/release-seat", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const count = Math.min(Math.max(parseInt(req.body.count) || 1, 1), TOTAL_SEATS);
  const calledNumbers = [];

  // 席を解放
  day.seatsInUse = Math.max(0, day.seatsInUse - count);

  // 空き席に収まる組を効率よく呼び出す（席に収まるなら順番を飛ばす）
  let fitting;
  while ((fitting = getNextFitting(day, TOTAL_SEATS - day.seatsInUse))) {
    const people = fitting.people || 1;
    fitting.called = true;
    day.callingNumber = Math.max(day.callingNumber, fitting.number);
    day.seatsInUse += people;
    calledNumbers.push({ number: fitting.number, people });
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

// スタッフ: 不在スキップ（呼んだけど来ない人を飛ばす）
app.post("/api/admin/skip", requireAdmin, (req, res) => {
  const today = getToday();
  const day = getDayState(today);
  const { number } = req.body;
  const ticket = day.ticketsByNum[number];

  if (ticket && ticket.called) {
    ticket.skippedNoShow = true;
    // その人の分の席を解放
    day.seatsInUse = Math.max(0, day.seatsInUse - (ticket.people || 1));

    // 空いた席で次を呼ぶ
    const calledNumbers = [];
    let fitting;
    while ((fitting = getNextFitting(day, TOTAL_SEATS - day.seatsInUse))) {
      fitting.called = true;
      day.callingNumber = Math.max(day.callingNumber, fitting.number);
      day.seatsInUse += (fitting.people || 1);
      calledNumbers.push({ number: fitting.number, people: fitting.people || 1 });
    }

    return res.json({
      skipped: number,
      callingNumber: day.callingNumber,
      seatsInUse: day.seatsInUse,
      totalIssued: day.counter,
      availableSeats: Math.max(0, TOTAL_SEATS - day.seatsInUse),
      calledNumbers,
    });
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
