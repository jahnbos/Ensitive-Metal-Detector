// backend.js — ESP32 dashboard backend (Express + WS manual upgrade)

require("dotenv").config();
const sql = require("mssql");

const sqlConfig = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  database: process.env.AZURE_SQL_DB,
  server: process.env.AZURE_SQL_SERVER,
  options: {
    encrypt: true, // Azure ต้อง encrypt
    trustServerCertificate: false,
  },
};

// สร้าง pool ไว้ใช้ทั้งไฟล์
const poolPromise = sql.connect(sqlConfig).catch((err) => {
  console.error("SQL connect error:", err);
});

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

/* =========================
 * In-memory state
 * ========================= */
let systemEnabled = true;
let detectionCount = 0;

let current = {
  value: 0,
  threshold: 0.5,
  detected: false,
  buzzer_on: false,
  servo_angle: 0,
  oled_lines: ["MAG:0 TH:0", "STATE:IDLE CNT:0", "BUZZER:OFF SERVO:0"],
};

let logs = []; // [{LogID, detected_at, sensor_value}]
let signal = []; // [{t: epoch_ms, v: number}]
const SIGNAL_KEEP_MS = 60 * 60 * 1000; // เก็บสัญญาณย้อนหลัง 1 ชม.

// ฟังก์ชันนี้รับค่าตัวอย่างสัญญาณจากอุปกรณ์, เก็บไว้ในหน่วยความจำ, พยายามเขียนลง Azure SQL และตัดข้อมูลเก่าออก
function addSample(v) {
  const now = Date.now();
  signal.push({ t: now, v: Number(v) || 0 });
  (async () => {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("T", sql.BigInt, now)
        .input("V", sql.Float, v)
        .query("INSERT INTO Signal (T, V) VALUES (@T, @V)");
    } catch (err) {
      console.error("Insert Signal failed:", err);
    }
  })();
  const cutoff = now - SIGNAL_KEEP_MS;
  if (signal.length > 0 && signal[0].t < cutoff) {
    const idx = signal.findIndex((s) => s.t >= cutoff);
    if (idx > 0) signal = signal.slice(idx);
  }
}

// ฟังก์ชันนี้แปลงสัญญาณในหน่วยความจำให้กลายเป็นจุดสำหรับกราฟ โดยเฉลี่ยเป็นช่วง ๆ ตาม bucketSec
function getChartPoints(bucketSec = 10) {
  const now = Date.now();
  const start = now - SIGNAL_KEEP_MS;
  const buckets = [];
  const step = bucketSec * 1000;

  for (let t = start; t <= now; t += step) {
    const tEnd = t + step;
    const xs = signal.filter((p) => p.t >= t && p.t < tEnd).map((p) => p.v);
    const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    buckets.push({ t, avg });
  }
  return buckets;
}

// ฟังก์ชันนี้สร้าง histogram ของค่าที่เก็บล่าสุด เพื่อใช้แสดงการกระจายตัวของสัญญาณ
function getHistogram(binCount = 8) {
  if (signal.length === 0) return { bins: [] };
  const vals = signal.map((s) => s.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (min === max) {
    return {
      bins: Array.from({ length: binCount }, (_, i) => ({
        i,
        count: i === 0 ? vals.length : 0,
      })),
    };
  }
  const bins = Array.from({ length: binCount }, () => 0);
  vals.forEach((v) => {
    let idx = Math.floor(((v - min) / (max - min)) * binCount);
    if (idx === binCount) idx = binCount - 1;
    bins[idx] += 1;
  });
  return { bins: bins.map((c, i) => ({ i, count: c })) };
}

/* =========================
 * HTTP + WebSocket (manual upgrade)
 * ========================= */
const PORT = process.env.PORT || 3100;
const server = http.createServer(app);

// ใช้ noServer และปิด perMessageDeflate กันปัญหาเฟรม
const wssBrowser = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});
const wssDevice = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// upgrade เฉพาะเส้นทางที่ต้องการเท่านั้น
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/ws/telemetry") {
    wssBrowser.handleUpgrade(req, socket, head, (ws) => {
      wssBrowser.emit("connection", ws, req);
    });
  } else if (url === "/ws/device") {
    wssDevice.handleUpgrade(req, socket, head, (ws) => {
      wssDevice.emit("connection", ws, req);
    });
  } else {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  }
});

// ฟังก์ชันนี้กระจายข้อความไปยัง client ฝั่ง browser ทุกตัว
function broadcastBrowser(obj) {
  const data = JSON.stringify(obj);
  wssBrowser.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

// ฟังก์ชันนี้กระจายข้อความไปยัง client ฝั่งอุปกรณ์ทุกตัว
function broadcastDevice(obj) {
  const data = JSON.stringify(obj);
  wssDevice.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

// ส่วนนี้จัดการ connection จาก browser เมื่อเชื่อมต่อผ่าน WS แล้วส่งสถานะเริ่มต้นกลับไป
wssBrowser.on("connection", (ws) => {
  console.log("[WS] browser connected");
  // ส่ง hello หลัง handshake เสร็จ
  setImmediate(() => {
    try {
      ws.send(
        JSON.stringify({
          type: "hello",
          current,
          detection_count: detectionCount,
          system_enabled: systemEnabled,
        })
      );
    } catch (e) {}
  });
  ws.on("close", () => console.log("[WS] browser closed"));
});

// ส่วนนี้จัดการ connection จากอุปกรณ์ที่เชื่อมต่อผ่าน WS
wssDevice.on("connection", (ws) => {
  console.log("[WS] device connected");
  ws.on("close", () => console.log("[WS] device closed"));
});

/* =========================
 * REST API
 * ========================= */
// endpoint นี้คืนค่าภาพรวมสถานะระบบปัจจุบัน
app.get("/api/status", (req, res) => {
  res.json({
    detection_count: detectionCount,
    system_enabled: systemEnabled,
    current,
  });
});

// endpoint นี้ดึง log จากฐานข้อมูล (ถ้าไม่ได้จะใช้จากในหน่วยความจำ)
app.get("/api/logs", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .query(
        "SELECT TOP (500) Id, DetectedAt, SensorValue FROM Logs ORDER BY Id DESC"
      );
    res.json(result.recordset);
  } catch (err) {
    console.error("Select Logs failed:", err);
    // fallback ส่งจากในหน่วยความจำ
    res.json(logs.slice(-500));
  }
});

// endpoint นี้คืนข้อมูลจุดกราฟที่ประมวลผลแล้ว
app.get("/api/chart", (req, res) => {
  res.json({ points: getChartPoints(10) });
});

// endpoint นี้คืนข้อมูล histogram เพื่อนำไปแสดงกราฟแท่ง
app.get("/api/histogram", (req, res) => {
  res.json(getHistogram(8));
});

// endpoint นี้รีเซ็ตตัวนับการตรวจจับและแจ้ง browser
app.post("/api/reset", (req, res) => {
  detectionCount = 0;
  current.oled_lines[1] = `STATE:${
    current.detected ? "DETECTED" : "IDLE"
  } CNT:${detectionCount}`;
  broadcastBrowser({ type: "counter", detection_count: detectionCount });
  res.json({ ok: true });
});

// endpoint นี้เปิด/ปิดระบบจาก dashboard แล้วกระจายสถานะไปยัง browser
app.post("/api/enable", (req, res) => {
  systemEnabled = !!req.body.enabled;
  broadcastBrowser({ type: "enabled", enabled: systemEnabled });
  res.json({ ok: true, enabled: systemEnabled });
});

// endpoint นี้ใช้ควบคุม buzzer/servo แล้วแจ้งทั้งอุปกรณ์และ browser
app.post("/api/control", (req, res) => {
  const { buzzer_on, servo_angle } = req.body || {};
  if (typeof buzzer_on === "boolean") current.buzzer_on = buzzer_on;
  if (typeof servo_angle === "number")
    current.servo_angle = Math.max(0, Math.min(180, Math.floor(servo_angle)));
  current.oled_lines[2] = `BUZZER:${current.buzzer_on ? "ON" : "OFF"} SERVO:${
    current.servo_angle
  }`;
  broadcastDevice({
    type: "control",
    buzzer_on: current.buzzer_on,
    servo_angle: current.servo_angle,
  });
  broadcastBrowser({
    type: "telemetry",
    ...current,
    detection_count: detectionCount,
    system_enabled: systemEnabled,
  });
  res.json({ ok: true });
});

// endpoint นี้คือจุดรับข้อมูล telemetry จาก ESP32 แล้วอัปเดตสถานะ เก็บ log และกระจายไปยัง browser
app.post("/api/ingest", (req, res) => {
  const data = req.body;
  if (!data || typeof data.value === "undefined")
    return res.status(400).json({ ok: false });

  current.value = Number(data.value) || 0;
  if (typeof data.threshold === "number") current.threshold = data.threshold;
  if (typeof data.detected === "boolean") current.detected = data.detected;
  if (typeof data.buzzer_on === "boolean") current.buzzer_on = data.buzzer_on;
  if (typeof data.servo_angle === "number")
    current.servo_angle = Math.max(
      0,
      Math.min(180, Math.floor(data.servo_angle))
    );

  const thr = Math.round((current.threshold || 0) * 100);
  current.oled_lines[0] = `MAG:${Math.round(current.value)} TH:${thr}`;
  current.oled_lines[1] = `STATE:${
    current.detected ? "DETECTED" : "IDLE"
  } CNT:${detectionCount}`;
  current.oled_lines[2] = `BUZZER:${current.buzzer_on ? "ON" : "OFF"} SERVO:${
    current.servo_angle
  }`;

  addSample(current.value);

  if (systemEnabled && current.detected === true) {
    detectionCount += 1;

    // เขียนลง Azure SQL
    (async () => {
      try {
        const pool = await poolPromise;
        await pool
          .request()
          .input("SensorValue", sql.Float, current.value)
          .query("INSERT INTO Logs (SensorValue) VALUES (@SensorValue)");
      } catch (err) {
        console.error("Insert Logs failed:", err);
      }
    })();

    // เก็บในหน่วยความจำไว้ใช้ทันทีเหมือนเดิม
    logs.push({
      LogID: Date.now(),
      detected_at: new Date().toISOString(),
      sensor_value: current.value,
    });
    if (logs.length > 2000) logs = logs.slice(-1500);

    broadcastBrowser({ type: "notify", message: "Magnetic object detected." });
  }

  broadcastBrowser({
    type: "telemetry",
    ...current,
    detection_count: detectionCount,
    system_enabled: systemEnabled,
  });
  return res.json({ ok: true });
});

/* =========================
 * Start
 * ========================= */
// ส่วนนี้สตาร์ต HTTP server และแจ้ง endpoint ที่ใช้ได้
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  console.log(`WS (browser): ws://<host>:${PORT}/ws/telemetry`);
  console.log(`WS (device) : ws://<host>:${PORT}/ws/device`);
});
