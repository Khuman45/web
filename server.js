// 


const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Discord webhook URL
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// ----------------------------------------------------------------------
// ✔ IMPORTANT: Render needs an ABSOLUTE path that points to a PERSISTENT DISK
// After adding a disk in Render, mount it to /var/data
// ----------------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || "/var/data/weather.db";
console.log("Using SQLite DB at:", DB_PATH);

// --- SQLite setup ---
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
});

// --- Serve static frontend files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- HTTP + WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastJSON(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// --- Discord Alerts ---
async function sendDiscordNotification(temp, hum) {
  if (!DISCORD_WEBHOOK_URL) return;

  if (temp <= 30) return;

  const content =
    `🔥 **HIGH TEMPERATURE ALERT!**\n` +
    `Current reading: 🌡️ **${temp.toFixed(1)}°C**, 💧 **${hum.toFixed(1)}%**`;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content });
  } catch (err) {
    console.error('Error sending Discord webhook:', err.message);
  }
}

// --- API: Wokwi POST endpoint ---
app.post('/api/readings', (req, res) => {
  const { temperature, humidity } = req.body;

  if (typeof temperature !== 'number' || typeof humidity !== 'number') {
    return res.status(400).json({ error: 'temperature and humidity must be numbers' });
  }

  const createdAt = new Date().toISOString();

  db.run(
    'INSERT INTO readings (temperature, humidity, created_at) VALUES (?, ?, ?)',
    [temperature, humidity, createdAt],
    function (err) {
      if (err) {
        console.error('DB insert error:', err);
        return res.status(500).json({ error: 'DB error' });
      }

      const reading = {
        id: this.lastID,
        temperature,
        humidity,
        created_at: createdAt
      };

      broadcastJSON({ type: 'new-reading', data: reading });
      sendDiscordNotification(temperature, humidity);

      res.status(201).json(reading);
    }
  );
});

// --- API: Get all / recent readings ---
app.get('/api/readings', (req, res) => {
  const limit = Number(req.query.limit) || 50;

  db.all(
    'SELECT * FROM readings ORDER BY created_at DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) {
        console.error('DB select error:', err);
        return res.status(500).json({ error: 'DB error' });
      }
      res.json(rows);
    }
  );
});

// --- API: Get latest reading ---
app.get('/api/readings/latest', (req, res) => {
  db.get(
    'SELECT * FROM readings ORDER BY created_at DESC LIMIT 1',
    [],
    (err, row) => {
      if (err) {
        console.error('DB latest error:', err);
        return res.status(500).json({ error: 'DB error' });
      }
      if (!row) return res.status(404).json({ error: 'No data yet' });
      res.json(row);
    }
  );
});

// --- WebSocket connections ---
wss.on('connection', ws => {
  console.log('WebSocket client connected');

  db.get(
    'SELECT * FROM readings ORDER BY created_at DESC LIMIT 1',
    [],
    (err, row) => {
      if (!err && row) {
        ws.send(JSON.stringify({ type: 'latest-reading', data: row }));
      }
    }
  );

  ws.on('close', () => console.log('WebSocket client disconnected'));
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
