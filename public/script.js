// script.js — ESP32 Dashboard (works with backend.js v2)

/** =========================
 *  0) CONFIG
 *  ========================= */
const BACKEND_HOST = "127.0.0.1"; // เปลี่ยนเป็น "192.168.x.x" ได้
const BACKEND_PORT = 3100;

const API = (p) => `http://${BACKEND_HOST}:${BACKEND_PORT}${p}`;
const WS_URL = `ws://${BACKEND_HOST}:${BACKEND_PORT}/ws/telemetry`;

/** DOM refs (ตาม index.html ของคุณ) */
const elValNow = document.getElementById("valNow");
const elValCount = document.getElementById("valCount");
const elBtnReset = document.getElementById("btnReset");
const elLnkReset = document.getElementById("lnkReset");
const elLogsTbody = document.getElementById("logsTbody");
const elOl1 = document.getElementById("ol1");
const elOl2 = document.getElementById("ol2");
const elOl3 = document.getElementById("ol3");
const elSwServo = document.getElementById("swServo");
const elSwBuzzer = document.getElementById("swBuzzer");
const elSignal = document.getElementById("signalChart");
const elHist = document.getElementById("histChart");

/** =========================
 *  1) MINI CHART ENGINE (SVG)
 *  ========================= */
// ฟังก์ชันนี้วาดกราฟเส้นแบบ SVG จากชุดจุด (t,v) แล้วใส่ลง container
function svgLineChart(
  container,
  points,
  { height = 230, color = "#7f8cff" } = {},
) {
  if (!container) return;
  const w = container.clientWidth || 600;
  const h = height;
  container.innerHTML = "";

  if (!points || points.length === 0) {
    container.textContent = "No data yet";
    return;
  }

  // normalize data
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.v);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const rx = (x) =>
    maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * (w - 20) + 10;
  const ry = (y) =>
    maxY === minY ? h / 2 : h - 10 - ((y - minY) / (maxY - minY)) * (h - 20);

  const path = points
    .map((p, i) => {
      const x = rx(p.t),
        y = ry(p.v);
      return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
    })
    .join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  // grid light
  const grid = document.createElementNS(svg.namespaceURI, "g");
  grid.setAttribute("stroke", "rgba(255,255,255,.08)");
  for (let i = 1; i < 6; i++) {
    const y = (h / 6) * i;
    const ln = document.createElementNS(svg.namespaceURI, "line");
    ln.setAttribute("x1", "10");
    ln.setAttribute("x2", w - 10);
    ln.setAttribute("y1", y);
    ln.setAttribute("y2", y);
    grid.appendChild(ln);
  }
  svg.appendChild(grid);

  const pathEl = document.createElementNS(svg.namespaceURI, "path");
  pathEl.setAttribute("d", path);
  pathEl.setAttribute("fill", "none");
  pathEl.setAttribute("stroke", color);
  pathEl.setAttribute("stroke-width", "2.0");
  svg.appendChild(pathEl);

  container.appendChild(svg);
}

// ฟังก์ชันนี้วาดกราฟแท่ง (histogram) จากจำนวนต่อ bin แล้วใส่ลง container
function svgBars(container, bins, { height = 180 } = {}) {
  if (!container) return;
  const w = container.clientWidth || 480;
  const h = height;
  container.innerHTML = "";

  if (!bins || bins.length === 0) {
    container.textContent = "No data yet";
    return;
  }

  const counts = bins.map((b) => b.count);
  const maxC = Math.max(...counts) || 1;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  const barW = Math.max(4, Math.floor((w - 20) / bins.length));
  bins.forEach((b, i) => {
    const x = 10 + i * barW;
    const bh = Math.round((b.count / maxC) * (h - 20));
    const y = h - 10 - bh;

    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barW - 2);
    rect.setAttribute("height", bh);
    rect.setAttribute("fill", "#62e9de");
    rect.setAttribute("opacity", "0.85");
    svg.appendChild(rect);
  });

  container.appendChild(svg);
}

/** =========================
 *  2) LOAD INITIAL DATA
 *  ========================= */
// ฟังก์ชันนี้โหลดสถานะเริ่มต้น, log และข้อมูลกราฟจาก backend แล้วแสดงบนหน้าเว็บ
async function loadInitial() {
  // status
  const st = await fetch(API("/api/status")).then((r) => r.json());
  applyTelemetry(st.current);
  setCount(st.detection_count);

  // logs (ล่าสุด → บนสุด)
  const logs = await fetch(API("/api/logs")).then((r) => r.json());
  elLogsTbody.innerHTML = "";
  logs.slice(-200).forEach(appendLog);

  // charts
  try {
    const chart = await fetch(API("/api/chart")).then((r) => r.json());
    const pts = (chart.points || [])
      .filter((p) => p.avg !== null)
      .map((p) => ({ t: p.t, v: p.avg }));
    svgLineChart(elSignal, pts, {
      height: elSignal?.classList.contains("small-chart") ? 180 : 230,
    });

    const hist = await fetch(API("/api/histogram")).then((r) => r.json());
    svgBars(elHist, hist.bins || [], {
      height: elHist?.classList.contains("small-chart") ? 180 : 230,
    });
  } catch (e) {
    console.warn("chart load failed", e);
  }
}

/** =========================
 *  3) WEBSOCKET (REALTIME)
 *  ========================= */
// ฟังก์ชันนี้เปิด WebSocket ไป backend เพื่อนำข้อความ realtime มาอัปเดต UI
function connectWS() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => console.log("WS connected");
  ws.onclose = () => {
    console.warn("WS closed, retry in 2s");
    setTimeout(connectWS, 2000);
  };
  ws.onerror = (e) => console.error("WS error", e);

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      if (typeof msg.detection_count === "number")
        setCount(msg.detection_count);
      if (msg.current) applyTelemetry(msg.current);
      return;
    }
    if (msg.type === "telemetry") {
      if (typeof msg.detection_count === "number")
        setCount(msg.detection_count);
      applyTelemetry(msg);
      // append live point to signal line
      pushSignalPoint(msg.value);
      return;
    }
    if (msg.type === "counter") {
      setCount(msg.detection_count ?? 0);
      return;
    }
    if (msg.type === "oled") {
      if (Array.isArray(msg.lines)) renderOLED(msg.lines);
      return;
    }
    if (msg.type === "notify") {
      // คุณจะโชว์ toast ตรงนี้ก็ได้
      console.log("NOTIFY:", msg.message);
      return;
    }
  };
}

/** =========================
 *  4) UI BINDINGS (buttons/switches)
 *  ========================= */
elBtnReset?.addEventListener("click", (e) => {
  e.preventDefault();
  doReset();
});
elLnkReset?.addEventListener("click", (e) => {
  e.preventDefault();
  doReset();
});

elSwServo?.addEventListener("change", async (e) => {
  const angle = e.target.checked ? 90 : 0;
  await fetch(API("/api/control"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servo_angle: angle }),
  });
});
elSwBuzzer?.addEventListener("change", async (e) => {
  const buzzer_on = !!e.target.checked;
  await fetch(API("/api/control"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buzzer_on }),
  });
});

/** =========================
 *  5) HELPERS (apply → UI)
 *  ========================= */
// ฟังก์ชันนี้ตั้งค่าจำนวนการตรวจจับบน UI และซิงก์ไปยังบรรทัด OLED
function setCount(n) {
  if (elValCount) elValCount.textContent = n ?? 0;
  updateOLEDCount(n);
}

// ฟังก์ชันนี้รับ telemetry จาก backend แล้วอัปเดตตัวเลข, OLED และสวิตช์ในหน้าเว็บ
function applyTelemetry(d) {
  // ตัวเลขปัจจุบัน
  if (typeof d?.value === "number" && elValNow)
    elValNow.textContent = Math.round(d.value);

  // OLED lines
  const thr = Math.round((d?.threshold ?? 0) * 100);
  const val = Math.round(d?.value ?? 0);
  const buz = d?.buzzer_on ? "ON" : "OFF";
  const ang = d?.servo_angle ?? 0;
  const state = d?.detected ? "DETECTED" : "IDLE";

  if (elOl1) elOl1.textContent = `MAG:${val} TH:${thr}`;
  if (elOl3) elOl3.textContent = `BUZZER:${buz} SERVO:${ang}`;
  updateOLEDCount(null, state); // แก้เฉพาะ STATE

  // sync switches
  if (elSwBuzzer) elSwBuzzer.checked = !!d?.buzzer_on;
  if (elSwServo) elSwServo.checked = Number(d?.servo_angle || 0) > 45;
}

// ฟังก์ชันนี้รับชุดข้อความจาก backend แล้ววาดลงจอ OLED จำลองบนหน้าเว็บ
function renderOLED(lines) {
  if (!Array.isArray(lines)) return;
  if (elOl1) elOl1.textContent = lines[0] ?? elOl1.textContent;
  if (elOl2) elOl2.textContent = lines[1] ?? elOl2.textContent;
  if (elOl3) elOl3.textContent = lines[2] ?? elOl3.textContent;
}

// ฟังก์ชันนี้แก้เฉพาะบรรทัดที่ 2 ของ OLED ให้ตรงกับ state และ counter ปัจจุบัน
function updateOLEDCount(count = null, state = null) {
  if (!elOl2) return;
  // รูปแบบเดิม: "STATE: IDLE CNT: 0"
  const text = elOl2.textContent;
  const m = text.match(/^STATE:\s*([A-Z]+)\s+CNT:\s*(\d+)/i);
  let curState = m ? m[1] : "IDLE";
  let curCnt = m ? m[2] : "0";
  if (state !== null) curState = state;
  if (count !== null) curCnt = String(count);
  elOl2.textContent = `STATE:${curState} CNT:${curCnt}`;
}

// ฟังก์ชันนี้สร้างแถวใหม่ในตาราง log จากข้อมูลที่ได้มา แล้วจำกัดจำนวนแถวไม่ให้ยาวเกิน
function appendLog(entry) {
  if (!elLogsTbody) return;
  const tr = document.createElement("tr");
  const t = new Date(entry.detected_at).toLocaleTimeString();
  tr.innerHTML = `<td>${t}</td><td>${Math.round(entry.sensor_value)}</td>`;
  elLogsTbody.prepend(tr);
  while (elLogsTbody.rows.length > 100) elLogsTbody.deleteRow(-1);
}

// ฟังก์ชันนี้เก็บจุดสัญญาณล่าสุดไว้ในหน่วยความจำฝั่งหน้าเว็บแล้ววาดกราฟเส้นใหม่
let _signalRecent = [];
function pushSignalPoint(val) {
  if (!elSignal) return;
  _signalRecent.push({ t: Date.now(), v: Number(val || 0) });
  if (_signalRecent.length > 120) _signalRecent.shift();
  svgLineChart(elSignal, _signalRecent, {
    height: elSignal.classList.contains("small-chart") ? 180 : 230,
  });
}

// ฟังก์ชันนี้ยิงคำสั่ง reset ไป backend เพื่อรีเซ็ตตัวนับ
async function doReset() {
  await fetch(API("/api/reset"), { method: "POST" });
  // backend จะ broadcast counter ใหม่ทาง WS ให้อีกชั้น
}

/** =========================
 *  6) BOOT
 *  ========================= */
// ฟังก์ชันเริ่มต้นเมื่อ DOM โหลดเสร็จ: โหลดข้อมูลแรกเข้า แล้วค่อยเปิด WS
window.addEventListener("DOMContentLoaded", async () => {
  await loadInitial();
  connectWS();
});
