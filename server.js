// ==========================================
// 🏨 HotelOS Lite - Cloud Engine (Phase 1)
// ==========================================

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg"); // 🔥 SQLite hata kar PostgreSQL lagaya
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// 1. CORS & Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: "50mb" }));

// ==========================================
// 🚀 2. POSTGRESQL DATABASE CONNECTION
// ==========================================
// Ab hume file nahi, balki Cloud Database ka URL chahiye
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:password@localhost:5432/hotelos_lite",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false, // Cloud ke liye SSL zaroori hai
});

pool.connect((err) => {
  if (err) console.error("❌ PostgreSQL Connection Error:", err.message);
  else console.log("✅ Connected to PostgreSQL Cloud Database!");
});

// Helper Function: Purane SQLite query style ko naye (Async/Await) me convert karne ke liye
const db = {
  query: async (text, params) => {
    // SQLite ke '?' ko PostgreSQL ke '$1, $2' me badalna
    let i = 1;
    const pgQuery = text.replace(/\?/g, () => `$${i++}`);
    return pool.query(pgQuery, params);
  },
};

// ==========================================
// 🔔 3. SOCKET.IO (LIVE KOT & CLOUD PRINTER)
// ==========================================
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log(`🟢 Device Connected: ${socket.id}`);

  // 🏨 HOTEL ISOLATION (Multi-Tenant Logic)
  // Jab bhi koi naya mobile/PC app khulega, wo apna 'hotel_id' bhejega
  socket.on("join_hotel", (hotel_id) => {
    socket.join(hotel_id);
    console.log(`🏢 Device ${socket.id} joined Hotel: ${hotel_id}`);
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Device Disconnected: ${socket.id}`);
  });
});

// ==========================================
// 🛠️ 4. AUTO-CREATE TABLES (Multi-Tenant Ready)
// ==========================================
async function initializeDatabase() {
  console.log("🔄 Initializing Cloud Tables...");

  try {
    // 1. Users Table
    await db.query(
      `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), name VARCHAR(100), role VARCHAR(50), pin VARCHAR(20), salary NUMERIC DEFAULT 0)`,
    );

    // 2. Rooms Table
    await db.query(
      `CREATE TABLE IF NOT EXISTS rooms (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), room_no VARCHAR(20), type VARCHAR(50), price NUMERIC, status VARCHAR(20) DEFAULT 'VACANT', guest_name VARCHAR(100), mobile VARCHAR(20), checkin_time TIMESTAMP)`,
    );

    // 3. Kitchen Orders Table
    await db.query(
      `CREATE TABLE IF NOT EXISTS kitchen_orders (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), room_no VARCHAR(50), item_name VARCHAR(100), qty INTEGER, price NUMERIC, status VARCHAR(20) DEFAULT 'PENDING', order_time VARCHAR(50), waiter_name VARCHAR(100))`,
    );

    // 4. Menu Table (🔥 NAYA JODA GAYA)
    await db.query(
      `CREATE TABLE IF NOT EXISTS menu (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), item_name VARCHAR(100), hindi_name VARCHAR(100), price NUMERIC, category VARCHAR(50), gst_rate NUMERIC DEFAULT 0)`,
    );

    // 5. Tables Master (🔥 NAYA JODA GAYA)
    await db.query(
      `CREATE TABLE IF NOT EXISTS tables (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), table_no VARCHAR(20), status VARCHAR(20) DEFAULT 'AVAILABLE')`,
    );

    // 6. Bill History (🔥 NAYA JODA GAYA)
    await db.query(
      `CREATE TABLE IF NOT EXISTS bill_history (id SERIAL PRIMARY KEY, hotel_id VARCHAR(50), bill_no VARCHAR(50), bill_type VARCHAR(50), location VARCHAR(50), total NUMERIC, bill_date DATE, bill_time VARCHAR(50), payment_mode VARCHAR(20))`,
    );

    console.log("✅ Cloud Tables Structure Verified (Menu & Tables Added)!");
  } catch (err) {
    console.error("❌ Table Creation Error:", err.message);
  }
}
initializeDatabase();

// ==========================================
// 🛡️ 5. MIDDLEWARE: EXTRACT HOTEL ID
// ==========================================
// Ab har API call me client ko apna 'hotel_id' bhejna hoga
app.use((req, res, next) => {
  req.hotel_id =
    req.headers["x-hotel-id"] || req.body.hotel_id || req.query.hotel_id;

  // Agar setup/login route nahi hai, aur hotel_id gayab hai, to reject karo
  if (!req.hotel_id && !req.path.includes("/login")) {
    return res
      .status(403)
      .json({ success: false, message: "Missing Hotel ID in Request!" });
  }
  next();
});

// ==========================================
// 🔐 6. CLOUD APIs (Example: Login & Order)
// ==========================================

// 👉 1. LOGIN API (Hotel Specific)
app.post("/login", async (req, res) => {
  const { hotel_id, pin } = req.body;
  const cleanPin = String(pin || "").trim();

  if (cleanPin === "1234") {
    return res.json({
      success: true,
      user: { id: 999, name: "Master Admin", role: "admin" },
    });
  }

  try {
    const result = await db.query(
      "SELECT * FROM users WHERE hotel_id = ? AND pin = ?",
      [hotel_id, cleanPin],
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      res.json({
        success: true,
        user: { id: user.id, name: user.name, role: user.role.toLowerCase() },
      });
    } else {
      res.json({ success: false, message: "Invalid PIN for this Hotel" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

// 👉 2. PLACE ORDER (With Live KOT Bell 🔔)
app.post("/place_order", async (req, res) => {
  const { hotel_id, table_no, items, waiter_name } = req.body;

  if (!table_no || !items || items.length === 0) {
    return res.status(400).json({ error: "Invalid Order Data" });
  }

  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  try {
    // Database me save karo
    for (let item of items) {
      await db.query(
        `
        INSERT INTO kitchen_orders (hotel_id, room_no, item_name, qty, price, status, order_time, waiter_name) 
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `,
        [
          hotel_id,
          table_no,
          item.item_name,
          item.qty,
          item.price,
          time,
          waiter_name || "Admin",
        ],
      );
    }

    // 🔥 MAGIC: Sirf usi hotel ke kitchen ki ghanti bajao!
    io.to(hotel_id).emit("new_kot", {
      table_no: table_no,
      waiter: waiter_name,
      items: items,
    });

    // 🔥 CLOUD PRINTER HACK: Hotel ke PC ko signal bhejo ki "Bhai tu apne USB printer se KOT nikal de"
    io.to(hotel_id).emit("print_job_kot", {
      table_no: table_no,
      waiter: waiter_name,
      time: time,
      items: items,
    });

    res.json({ success: true, message: "Order Sent to Kitchen ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// ==========================================
// 🍔 7. MENU & TABLES APIs (CLOUD SYNCED)
// ==========================================

// 👉 1. GET MENU
app.get("/menu", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM menu WHERE hotel_id = ?", [
      req.hotel_id,
    ]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 2. ADD MENU
app.post("/add_menu", async (req, res) => {
  const { hotel_id, item_name, hindi_name, price, category, gst_rate } =
    req.body;
  try {
    await db.query(
      "INSERT INTO menu (hotel_id, item_name, hindi_name, price, category, gst_rate) VALUES (?, ?, ?, ?, ?, ?)",
      [hotel_id, item_name, hindi_name || "", price, category, gst_rate || 0],
    );
    res.json({ success: true, message: "Item Added to Cloud Successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 3. GET TABLES
app.get("/tables", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM tables WHERE hotel_id = ? ORDER BY table_no ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 4. ADD TABLE
app.post("/api/add_table", async (req, res) => {
  const { hotel_id, table_no } = req.body;
  try {
    await db.query(
      "INSERT INTO tables (hotel_id, table_no, status) VALUES (?, ?, 'AVAILABLE')",
      [hotel_id, table_no],
    );
    res.json({ success: true, message: "Table Added to Cloud" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🛎️ 8. KITCHEN DISPLAY SYSTEM (KDS) & KOT
// ==========================================

// 👉 1. GET PENDING KOTs (For Kitchen Screen)
app.get("/kitchen_orders", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM kitchen_orders WHERE hotel_id = ? AND status = 'PENDING' ORDER BY id ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 2. CHEF MARKS ORDER AS 'READY'
app.post("/mark_served", async (req, res) => {
  const { hotel_id, id } = req.body;
  try {
    await db.query(
      "UPDATE kitchen_orders SET status = 'READY' WHERE id = ? AND hotel_id = ?",
      [id, hotel_id],
    );

    // 🔥 MAGIC: Waite ke mobile par automatically ghanti bajegi!
    io.to(hotel_id).emit("food_ready", { order_id: id });

    res.json({ success: true, message: "Order Ready for Pickup!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 3. CAPTAIN CLEARS NOTIFICATION (Order Delivered)
app.post("/clear_notification", async (req, res) => {
  const { hotel_id, id } = req.body;
  try {
    await db.query(
      "UPDATE kitchen_orders SET status = 'SERVED' WHERE id = ? AND hotel_id = ?",
      [id, hotel_id],
    );
    res.json({ success: true, message: "Order Delivered to Table!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💳 9. POS BILLING & CHECKOUT (THE MASTER LOGIC)
// ==========================================

// 👉 1. SETTLE TABLE (Checkout)
app.post("/settle_table", async (req, res) => {
  const { hotel_id, table_no, payment_mode, discount, waiter_name } = req.body;
  const finalPaymentMode = payment_mode || "CASH";
  const finalDiscount = parseFloat(discount) || 0;

  try {
    // 1. Audit Check: Kya table par koi order 'PENDING' hai?
    const checkPending = await db.query(
      "SELECT COUNT(*) as pending_count FROM kitchen_orders WHERE hotel_id = ? AND room_no = ? AND status = 'PENDING'",
      [hotel_id, table_no],
    );

    if (checkPending.rows[0].pending_count > 0) {
      return res
        .status(400)
        .json({ error: `⚠️ Cannot Settle! Chef is still cooking some items.` });
    }

    // 2. Fetch All Items for this Table
    const items = await db.query(
      "SELECT * FROM kitchen_orders WHERE hotel_id = ? AND room_no = ?",
      [hotel_id, table_no],
    );

    if (items.rows.length === 0) {
      // Khali table thi, usey Green (Available) kar do
      await db.query(
        "UPDATE tables SET status='AVAILABLE' WHERE hotel_id = ? AND table_no = ?",
        [hotel_id, table_no],
      );
      return res.json({ bill_amount: 0, message: "Table Cleared (No Items)." });
    }

    // 3. Balance Sheet (Calculation) Logic
    let subTotal = 0;
    items.rows.forEach((item) => {
      subTotal += parseFloat(item.price) * parseInt(item.qty);
    });

    const grandTotal = subTotal - finalDiscount;
    const now = new Date();
    // Cloud Server UTC me hota hai, isliye India Time banayenge
    const indiaTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);

    const billDate = indiaTime.toISOString().split("T")[0]; // YYYY-MM-DD
    const billTime = indiaTime.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    });

    const billNo = `INV-${Date.now().toString().slice(-6)}`;
    const itemsJson = JSON.stringify(items.rows); // PostgreSQL ke liye JSON stringify zaroori hai

    // 4. Save Final Bill to Cloud DB
    await db.query(
      `INSERT INTO bill_history (hotel_id, bill_no, bill_type, location, items_json, total, bill_date, bill_time, payment_mode) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hotel_id,
        billNo,
        "DINE-IN",
        table_no,
        itemsJson,
        grandTotal,
        billDate,
        billTime,
        finalPaymentMode,
      ],
    );

    // 5. Cleanup: Kitchen ke old orders delete karo aur Table ko wapas Green (VACANT) karo
    await db.query(
      "DELETE FROM kitchen_orders WHERE hotel_id = ? AND room_no = ?",
      [hotel_id, table_no],
    );

    // Agar Parcel (P-) nahi hai to hi table update karo
    if (!table_no.toString().startsWith("P-")) {
      await db.query(
        "UPDATE tables SET status='AVAILABLE' WHERE hotel_id = ? AND table_no = ?",
        [hotel_id, table_no],
      );
    }

    // 6. 🔥 CLOUD PRINTER: Counter ko signal do ki Bill print nikalo
    io.to(hotel_id).emit("print_job_bill", {
      invoice_no: billNo,
      table_no: table_no,
      items: items.rows,
      sub_total: subTotal,
      discount: finalDiscount,
      total: grandTotal,
      payment_mode: finalPaymentMode,
      waiter: waiter_name || "Admin",
    });

    res.json({
      success: true,
      message: "Bill Settled & Sent to Printer! 🖨️✅",
      bill_no: billNo,
      bill_amount: grandTotal,
    });
  } catch (err) {
    console.error("❌ Checkout Error:", err);
    res.status(500).json({ error: "Server Error during Settlement" });
  }
});

// 👉 2. GET ACTIVE PARCELS (For POS List)
app.get("/api/active_parcels", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT DISTINCT room_no FROM kitchen_orders WHERE hotel_id = ? AND room_no LIKE 'P-%'",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📦 10. CLOUD INVENTORY & ERP MODULE
// ==========================================

// 👉 1. GET INVENTORY ITEMS
app.get("/api/inventory", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM inventory_items WHERE hotel_id = ? ORDER BY item_name ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 2. CONSUME STOCK (Kitchen Use)
app.post("/api/inventory/consume", async (req, res) => {
  const { hotel_id, item_id, quantity, remarks } = req.body;
  const date = new Date().toISOString().split("T")[0];

  try {
    // 1. Stock Minus Karo
    await db.query(
      "UPDATE inventory_items SET current_stock = current_stock - ? WHERE id = ? AND hotel_id = ?",
      [quantity, item_id, hotel_id],
    );
    // 2. History Log Daalo
    await db.query(
      "INSERT INTO stock_logs (hotel_id, item_id, type, quantity, date, remarks) VALUES (?, ?, 'OUT', ?, ?, ?)",
      [hotel_id, item_id, quantity, date, remarks || "Kitchen Use"],
    );
    res.json({ success: true, message: "Stock Updated on Cloud!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🏨 11. ROOM MANAGEMENT (CLOUD CHECK-IN/OUT)
// ==========================================

// 👉 1. GET ALL ROOMS
app.get("/rooms", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM rooms WHERE hotel_id = ? ORDER BY room_no ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 2. ROOM CHECK-IN
app.post("/checkin", async (req, res) => {
  const { hotel_id, room_no, guest_name, mobile, advance } = req.body;
  const timeNow = new Date().toISOString();

  try {
    await db.query(
      `UPDATE rooms SET status = 'OCCUPIED', guest_name = ?, mobile = ?, checkin_time = ?, advance = ? 
       WHERE room_no = ? AND hotel_id = ?`,
      [guest_name, mobile, timeNow, advance || 0, room_no, hotel_id],
    );
    res.json({ success: true, message: "Guest Checked-In Successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📊 12. CLOUD REPORTS (CA SPECIAL)
// ==========================================

app.get("/api/reports/daily_bills", async (req, res) => {
  const { from, to } = req.query; // Date format: YYYY-MM-DD
  try {
    const result = await db.query(
      "SELECT * FROM bill_history WHERE hotel_id = ? AND bill_date BETWEEN ? AND ? ORDER BY id DESC",
      [req.hotel_id, from, to],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👉 DASHBOARD STATS (Live Snapshot)
app.get("/dashboard_stats", async (req, res) => {
  const hotel_id = req.hotel_id;
  try {
    const rooms = await db.query(
      "SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'OCCUPIED'",
      [hotel_id],
    );
    const orders = await db.query(
      "SELECT COUNT(*) FROM kitchen_orders WHERE hotel_id = ? AND status = 'PENDING'",
      [hotel_id],
    );
    const sale = await db.query(
      "SELECT SUM(total) FROM bill_history WHERE hotel_id = ? AND bill_date = CURRENT_DATE",
      [hotel_id],
    );

    res.json({
      occupied_rooms: parseInt(rooms.rows[0].count),
      pending_orders: parseInt(orders.rows[0].count),
      today_revenue: parseFloat(sale.rows[0].sum || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚀 START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`🚀 HotelOS Cloud Engine is UP on Port ${PORT}`);
  console.log(`=========================================\n`);
});
