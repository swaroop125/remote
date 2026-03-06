/**
 * ESP32 Robot WebSocket Relay Server
 * Deploy on Render (free tier) — bridges Dashboard ↔ ESP32
 *
 * Protocol:
 *   On connect, client must send a registration message:
 *     Dashboard: { "role": "dashboard", "secret": "YOUR_SECRET" }
 *     ESP32:     { "role": "robot",     "secret": "YOUR_SECRET" }
 *
 *   After registration:
 *     Dashboard → Server → ESP32:  any JSON command
 *     ESP32 → Server → Dashboard:  any JSON telemetry
 */

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ROBOT_SECRET || "esp32robot123"; // change this!

// Track clients
let dashboardClient = null;
let robotClient = null;

// HTTP server (required by Render — it expects a listening HTTP port)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "online",
      dashboard: dashboardClient ? "connected" : "disconnected",
      robot: robotClient ? "connected" : "disconnected",
    })
  );
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[+] New connection from ${ip}`);

  let role = null;
  let registered = false;

  // Give client 5 seconds to register
  const regTimeout = setTimeout(() => {
    if (!registered) {
      console.log(`[-] Client did not register in time, closing.`);
      ws.close(4001, "Registration timeout");
    }
  }, 5000);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // ── REGISTRATION ──
    if (!registered) {
      if (msg.secret !== SECRET) {
        ws.send(JSON.stringify({ error: "Bad secret" }));
        ws.close(4003, "Unauthorized");
        return;
      }
      if (!["dashboard", "robot"].includes(msg.role)) {
        ws.send(JSON.stringify({ error: "Role must be dashboard or robot" }));
        ws.close(4002, "Invalid role");
        return;
      }

      role = msg.role;
      registered = true;
      clearTimeout(regTimeout);

      if (role === "dashboard") {
        if (dashboardClient) dashboardClient.close(4000, "Replaced by new dashboard");
        dashboardClient = ws;
        console.log("[✓] Dashboard registered");
        ws.send(JSON.stringify({ type: "registered", role: "dashboard" }));
        // Notify dashboard of robot status
        ws.send(
          JSON.stringify({
            type: "robot_status",
            connected: robotClient && robotClient.readyState === WebSocket.OPEN,
          })
        );
      } else {
        if (robotClient) robotClient.close(4000, "Replaced by new robot");
        robotClient = ws;
        console.log("[✓] Robot (ESP32) registered");
        ws.send(JSON.stringify({ type: "registered", role: "robot" }));
        // Notify dashboard that robot connected
        if (dashboardClient && dashboardClient.readyState === WebSocket.OPEN) {
          dashboardClient.send(JSON.stringify({ type: "robot_status", connected: true }));
        }
      }
      return;
    }

    // ── RELAY ──
    if (role === "dashboard") {
      // Forward command to robot
      if (robotClient && robotClient.readyState === WebSocket.OPEN) {
        robotClient.send(raw.toString());
      } else {
        ws.send(JSON.stringify({ error: "Robot not connected" }));
      }
    } else if (role === "robot") {
      // Forward telemetry to dashboard
      if (dashboardClient && dashboardClient.readyState === WebSocket.OPEN) {
        dashboardClient.send(raw.toString());
      }
    }
  });

  ws.on("close", () => {
    if (role === "dashboard") {
      dashboardClient = null;
      console.log("[-] Dashboard disconnected");
    } else if (role === "robot") {
      robotClient = null;
      console.log("[-] Robot disconnected");
      if (dashboardClient && dashboardClient.readyState === WebSocket.OPEN) {
        dashboardClient.send(JSON.stringify({ type: "robot_status", connected: false }));
      }
    }
  });

  ws.on("error", (err) => console.error(`[!] WS error (${role}):`, err.message));
});

server.listen(PORT, () => {
  console.log(`🤖 Robot relay server running on port ${PORT}`);
  console.log(`🔑 Secret: ${SECRET}`);
});
