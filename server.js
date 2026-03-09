const express = require("express");
const cors = require("cors");
const { Pool } = require("pg"); // 🔥 SQLite hatakar Postgres (Supabase) laga diya
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// 🚀 1. CLOUD DATABASE CONNECTION (Supabase)
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Render ke Environment se link aayega
  ssl: { rejectUnauthorized: false },
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error("❌ PostgreSQL Connection Error:", err.stack);
  }
  console.log("✅ Connected to Supabase Cloud Database!");
  release();
});

// ==========================================
// 🛡️ 2. SECURITY GUARD (Middleware for Hotel ID)
// ==========================================
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Har API call par ye check karega ki kis hotel ka data dena hai
app.use((req, res, next) => {
  req.hotel_id =
    req.headers["x-hotel-id"] ||
    req.query.hotel_id ||
    (req.body && req.body.hotel_id);

  if (
    !req.hotel_id &&
    !req.path.includes("/login") &&
    !req.path.includes("/api/check-license")
  ) {
    return res
      .status(403)
      .json({ success: false, message: "Missing Hotel ID in Request!" });
  }
  next();
});

// ==========================================
// 🏗️ 3. CLOUD TABLE CREATION (Multi-Hotel Supported)
// ==========================================
async function initializeCloudDatabase() {
  const createTablesQuery = `
    -- 1. HOTEL SETTINGS
    CREATE TABLE IF NOT EXISTS hotel_settings (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100) UNIQUE, -- 🔥 Naya column
      hotel_name TEXT, address TEXT, mobile TEXT, gst_number TEXT, gst_percent REAL DEFAULT 0,
      email TEXT DEFAULT '', website TEXT DEFAULT '',
      full_day_hours REAL DEFAULT 9, half_day_hours REAL DEFAULT 4,
      gst_applicable INTEGER DEFAULT 0, gst_type TEXT DEFAULT 'EXCLUSIVE',
      business_type TEXT DEFAULT 'HOTEL_AND_RESTRO'
    );

    -- 2. USERS (Staff)
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      name TEXT, role TEXT, pin TEXT, salary REAL DEFAULT 0
    );

    -- 3. ROOMS
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      room_no VARCHAR(50), type TEXT, price REAL, status TEXT DEFAULT 'VACANT', 
      guest_name TEXT, mobile TEXT, address TEXT, aadhar TEXT, 
      checkin_date TEXT, checkin_time TEXT, checkout_date TEXT, 
      advance REAL DEFAULT 0, current_bill REAL DEFAULT 0, 
      guests_json TEXT, id_proof TEXT
    );

    -- 4. KITCHEN ORDERS
    CREATE TABLE IF NOT EXISTS kitchen_orders (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      room_no TEXT, location TEXT, item_name TEXT, hindi_name TEXT, qty INTEGER, price REAL, 
      status TEXT DEFAULT 'PENDING', order_time TEXT, completed_time TEXT, waiter_name TEXT, 
      notes TEXT, order_date TEXT
    );

    -- 5. BILL HISTORY
    CREATE TABLE IF NOT EXISTS bill_history (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      bill_no TEXT, bill_type TEXT, location TEXT, items_json TEXT, 
      total REAL, sub_total REAL DEFAULT 0, gst REAL, gst_percent REAL DEFAULT 0, gst_amount REAL DEFAULT 0,
      bill_date TEXT, bill_time TEXT, payment_mode TEXT DEFAULT 'CASH', 
      guests_json TEXT, guest_name TEXT DEFAULT 'Walk-in', mobile TEXT DEFAULT '',
      check_in TEXT DEFAULT '', round_off REAL DEFAULT 0, duration_mins INTEGER DEFAULT 0, waiter_name TEXT DEFAULT 'Admin'
    );

    -- 6. MENU
    CREATE TABLE IF NOT EXISTS menu (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      item_name TEXT, hindi_name TEXT, price REAL, category TEXT, image_url TEXT DEFAULT '',
      gst_rate REAL DEFAULT 0, linked_inventory_id INTEGER
    );

    -- 7. TABLES
    CREATE TABLE IF NOT EXISTS tables (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100), -- 🔥 Naya column
      table_no TEXT, status TEXT DEFAULT 'AVAILABLE'
    );

    -- 8. EXPENSES (Petty Cash)
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      hotel_id VARCHAR(100),
      date TEXT, category TEXT, amount REAL, payment_mode TEXT DEFAULT 'CASH',
      remarks TEXT, added_by TEXT DEFAULT 'Admin'
    );
  `;

  try {
    await pool.query(createTablesQuery);
    console.log("✅ Cloud Tables Created Successfully (Multi-Hotel Ready)!");
  } catch (err) {
    console.error("❌ Table Creation Error:", err.message);
  }
}

initializeCloudDatabase();

// ==========================================
// 🔑 4. AUTHENTICATION & USERS API
// ==========================================
app.post("/login", async (req, res) => {
  const { pin } = req.body;
  const cleanPin = String(pin || "").trim();

  // Master Admin Bypass (Emergency)
  if (cleanPin === "1234") {
    return res.json({
      success: true,
      user: {
        id: 999,
        name: "Master Admin",
        role: "admin",
        hotel_id: req.hotel_id,
      },
    });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE hotel_id = $1 AND pin = $2",
      [req.hotel_id, cleanPin],
    );
    if (result.rows.length > 0) {
      const user = result.rows[0];
      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          role: user.role.toLowerCase(),
          hotel_id: user.hotel_id,
        },
      });
    } else {
      res.json({
        success: false,
        message: "Invalid PIN (Not found in Staff List)",
      });
    }
  } catch (err) {
    res.json({ success: false, message: "Server Error" });
  }
});

app.get("/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE hotel_id = $1", [
      req.hotel_id,
    ]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/add_user", async (req, res) => {
  const { name, role, pin } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO users (hotel_id, name, role, pin, salary) VALUES ($1, $2, $3, $4, 0) RETURNING id",
      [req.hotel_id, name, role, pin],
    );
    res.json({ success: true, id: result.rows[0].id, message: "User Added" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// ⚙️ 5. SETTINGS API
// ==========================================
app.get("/get_settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM hotel_settings WHERE hotel_id = $1",
      [req.hotel_id],
    );
    let responseData = result.rows.length > 0 ? result.rows[0] : {};
    responseData.hotel_id = req.hotel_id;
    res.json(responseData);
  } catch (err) {
    res.status(500).json({});
  }
});

app.post("/save_settings", async (req, res) => {
  const { hotel_name, address, gst_number, mobile, email, website } = req.body;
  try {
    // Pehle delete karo purani settings is hotel ki, fir nayi dalo
    await pool.query("DELETE FROM hotel_settings WHERE hotel_id = $1", [
      req.hotel_id,
    ]);
    await pool.query(
      `INSERT INTO hotel_settings (hotel_id, hotel_name, address, gst_number, mobile, email, website) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.hotel_id,
        hotel_name,
        address,
        gst_number,
        mobile,
        email || "",
        website || "",
      ],
    );
    res.json({ message: "Settings Saved! ✅" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🍕 6. MENU API
// ==========================================
app.get("/menu", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM menu WHERE hotel_id = $1", [
      req.hotel_id,
    ]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/add_menu", async (req, res) => {
  const {
    item_name,
    hindi_name,
    price,
    category,
    image_url,
    gst_rate,
    gst,
    linked_inventory_id,
  } = req.body;
  const finalGst = gst_rate || gst || 0;
  try {
    const result = await pool.query(
      "INSERT INTO menu (hotel_id, item_name, hindi_name, price, category, image_url, gst_rate, linked_inventory_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
      [
        req.hotel_id,
        item_name,
        hindi_name,
        price,
        category,
        image_url || "",
        finalGst,
        linked_inventory_id || null,
      ],
    );
    res.json({ id: result.rows[0].id, message: "Added Successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 🪑 7. TABLES API
// ==========================================
app.get("/tables", async (req, res) => {
  try {
    const sql = `
      SELECT t.table_no, 
      CASE WHEN COUNT(k.id) > 0 THEN 'OCCUPIED' ELSE 'VACANT' END as status
      FROM tables t
      LEFT JOIN kitchen_orders k ON t.table_no = k.room_no AND k.hotel_id = $1 AND k.status = 'PENDING'
      WHERE t.hotel_id = $1
      GROUP BY t.table_no
    `;
    const result = await pool.query(sql, [req.hotel_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/add_table", async (req, res) => {
  const { table_no } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO tables (hotel_id, table_no) VALUES ($1, $2) RETURNING id",
      [req.hotel_id, table_no],
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🏨 8. ROOMS & CHECK-IN API
// ==========================================
app.get("/rooms", async (req, res) => {
  try {
    // 🔥 Subquery update ki gayi hai taaki Postgres me error na aaye (::TEXT cast use kiya hai)
    const sql = `
      SELECT r.*, 
      (
          SELECT COALESCE(SUM(k.price * k.qty), 0)
          FROM kitchen_orders k 
          WHERE k.hotel_id = $1 
          AND (k.room_no = r.room_no::TEXT OR k.room_no = 'Room ' || r.room_no::TEXT)
          AND k.status != 'PAID'
      ) as calculated_bill 
      FROM rooms r
      WHERE r.hotel_id = $1
      ORDER BY r.id ASC
    `;
    const result = await pool.query(sql, [req.hotel_id]);

    const finalRows = result.rows.map((row) => ({
      ...row,
      current_bill: row.status === "VACANT" ? 0 : row.calculated_bill || 0,
    }));
    res.json(finalRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/add_room", async (req, res) => {
  const { room_no, type, price } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO rooms (hotel_id, room_no, type, price) VALUES ($1, $2, $3, $4) RETURNING id",
      [req.hotel_id, room_no, type, price],
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/checkin", async (req, res) => {
  const {
    room_id,
    guest_name,
    mobile,
    address,
    advance,
    guests_json,
    id_proof,
    aadhar,
  } = req.body;

  const advAmount = parseFloat(advance) || 0;
  const nowObj = new Date();
  const dateStr = nowObj.toISOString().split("T")[0]; // YYYY-MM-DD
  const timeStr = nowObj.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  try {
    // 1. Check if occupied
    const checkRoom = await pool.query(
      "SELECT status FROM rooms WHERE hotel_id = $1 AND room_no = $2",
      [req.hotel_id, room_id],
    );
    if (checkRoom.rows.length > 0 && checkRoom.rows[0].status === "OCCUPIED") {
      return res.status(400).json({ error: "Room is already Occupied!" });
    }

    // 2. Update Room Status
    await pool.query(
      `UPDATE rooms SET 
       status = 'OCCUPIED', guest_name = $1, mobile = $2, address = $3, aadhar = $4, 
       checkin_date = $5, checkin_time = $6, advance = $7, guests_json = $8, id_proof = $9 
       WHERE hotel_id = $10 AND room_no = $11`,
      [
        guest_name,
        mobile,
        address || "",
        aadhar || "",
        dateStr,
        timeStr,
        advAmount,
        guests_json || "[]",
        id_proof || "",
        req.hotel_id,
        room_id,
      ],
    );

    res.json({ message: "Check-in Successful!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🍳 9. KITCHEN & PLACE ORDER API (KOT)
// ==========================================
app.post("/place_order", async (req, res) => {
  const { table_no, items, waiter_name } = req.body;

  if (!table_no || !items || items.length === 0) {
    return res.status(400).json({ error: "Invalid Order Data" });
  }

  const nowObj = new Date();
  const dateStr = nowObj.toISOString().split("T")[0];
  const timeStr = nowObj.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });
  const finalWaiter = waiter_name || "Admin";

  try {
    // 1. Mark Room/Table as OCCUPIED
    await pool.query(
      "UPDATE rooms SET status='OCCUPIED' WHERE hotel_id = $1 AND room_no = $2",
      [req.hotel_id, table_no],
    );
    await pool.query(
      "UPDATE tables SET status='OCCUPIED' WHERE hotel_id = $1 AND table_no = $2",
      [req.hotel_id, table_no],
    );

    // 2. Insert Orders using Loop
    for (let item of items) {
      await pool.query(
        `INSERT INTO kitchen_orders 
        (hotel_id, room_no, location, item_name, hindi_name, qty, price, status, order_time, waiter_name, notes, order_date) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11)`,
        [
          req.hotel_id,
          table_no,
          table_no,
          item.item_name,
          item.hindi_name || "",
          item.qty,
          item.price,
          timeStr,
          finalWaiter,
          item.notes || "",
          dateStr,
        ],
      );
    }

    res.json({ success: true, message: "Order Sent to Kitchen ✅" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kitchen Pending Orders (For Chef Screen)
app.get("/kitchen_orders", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM kitchen_orders WHERE hotel_id = $1 AND status = 'PENDING' ORDER BY id ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Order as READY (Chef Action)
app.post("/mark_served", async (req, res) => {
  const { id } = req.body;
  const timeString = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  try {
    await pool.query(
      "UPDATE kitchen_orders SET status='READY', completed_time=$1 WHERE id=$2 AND hotel_id=$3",
      [timeString, id, req.hotel_id],
    );
    res.json({ message: "Order Ready", time: timeString });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POS Screen Action (Clear Ready Order)
app.post("/clear_notification", async (req, res) => {
  const { id } = req.body;
  try {
    await pool.query(
      "UPDATE kitchen_orders SET status='SERVED' WHERE id = $1 AND hotel_id = $2",
      [id, req.hotel_id],
    );
    res.json({ message: "Order Served" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💸 10. CHECKOUT & SETTLE BILL API
// ==========================================

// Room Checkout API
app.post("/checkout", async (req, res) => {
  const {
    room_no,
    bill_type,
    guest_name,
    mobile,
    check_in,
    payment_mode,
    items,
    invoice_no,
    round_off,
    total_amount,
    gst_amount,
    sub_total,
    waiter_name,
  } = req.body;

  const nowObj = new Date();
  const billDate = nowObj.toISOString().split("T")[0];
  const billTime = nowObj.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  const finalGrandTotal = parseFloat(total_amount) || 0;
  const finalGst = parseFloat(gst_amount) || 0;
  const finalSub = parseFloat(sub_total) || finalGrandTotal - finalGst;
  const finalRound = parseFloat(round_off) || 0;
  const finalWaiter = waiter_name || "Admin";

  let durationMins = 1;
  if (check_in && check_in !== "-") {
    try {
      durationMins = Math.floor((nowObj - new Date(check_in)) / 60000);
      if (durationMins <= 0) durationMins = 1;
    } catch (e) {}
  }

  try {
    // 1. Generate Invoice Number (Agar blank hai)
    let finalBillNo = invoice_no;
    if (!finalBillNo || finalBillNo === "New" || finalBillNo === "") {
      const maxRes = await pool.query(
        "SELECT MAX(id) as max_id FROM bill_history WHERE hotel_id = $1",
        [req.hotel_id],
      );
      const nextId = (maxRes.rows[0].max_id || 0) + 1;
      finalBillNo = `${nextId}`;
    }

    // 2. Insert into Bill History
    await pool.query(
      `INSERT INTO bill_history (
        hotel_id, bill_no, bill_type, location, guest_name, mobile, items_json, 
        total, sub_total, gst_amount, round_off, payment_mode, bill_date, bill_time, check_in, waiter_name, duration_mins
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        req.hotel_id,
        finalBillNo,
        bill_type,
        room_no,
        guest_name,
        mobile,
        JSON.stringify(items || []),
        finalGrandTotal,
        finalSub,
        finalGst,
        finalRound,
        payment_mode,
        billDate,
        billTime,
        check_in,
        finalWaiter,
        durationMins,
      ],
    );

    // 3. Clear Kitchen Orders for this Room
    await pool.query(
      "DELETE FROM kitchen_orders WHERE hotel_id = $1 AND (room_no = $2 OR location = $2)",
      [req.hotel_id, room_no],
    );

    // 4. Free the Room / Table
    if (bill_type === "ROOM" || String(room_no).includes("Room")) {
      await pool.query(
        "UPDATE rooms SET status='VACANT', guest_name=NULL, mobile=NULL, advance=0 WHERE hotel_id = $1 AND room_no = $2",
        [req.hotel_id, room_no],
      );
    } else if (!String(room_no).toUpperCase().includes("PARCEL")) {
      await pool.query(
        "UPDATE tables SET status='AVAILABLE' WHERE hotel_id = $1 AND table_no = $2",
        [req.hotel_id, room_no],
      );
    }

    res.json({ success: true, message: "Bill Created", bill_no: finalBillNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Table Settlement API
app.post("/settle_table", async (req, res) => {
  const { table_no, payment_mode, discount, waiter_name } = req.body;

  try {
    // 1. Pending Order Check
    const pendingCheck = await pool.query(
      "SELECT COUNT(*) as count FROM kitchen_orders WHERE hotel_id = $1 AND (room_no = $2 OR location = $2) AND status = 'PENDING'",
      [req.hotel_id, table_no],
    );

    if (parseInt(pendingCheck.rows[0].count) > 0) {
      return res
        .status(400)
        .json({ error: `⚠️ Cannot Settle! Items are still cooking.` });
    }

    // 2. Fetch Orders for Calculation
    const itemsRes = await pool.query(
      `SELECT k.*, m.gst_rate 
       FROM kitchen_orders k
       LEFT JOIN menu m ON k.item_name = m.item_name AND m.hotel_id = $1
       WHERE k.hotel_id = $1 AND (k.room_no = $2 OR k.location = $2)`,
      [req.hotel_id, table_no],
    );

    const items = itemsRes.rows;
    if (items.length === 0) {
      await pool.query(
        "UPDATE tables SET status='AVAILABLE' WHERE hotel_id = $1 AND table_no = $2",
        [req.hotel_id, table_no],
      );
      return res.json({ bill_amount: 0, message: "Cleared (No Items)." });
    }

    let subTotal = 0;
    let totalGST = 0;

    items.forEach((item) => {
      const qty = parseInt(item.qty) || 1;
      const price = parseFloat(item.price) || 0;
      const gstPercent = parseFloat(item.gst_rate) || 0;
      const itemTotal = price * qty;
      const itemGstAmt = (itemTotal * gstPercent) / 100;
      subTotal += itemTotal;
      totalGST += itemGstAmt;
    });

    const finalDiscount = parseFloat(discount) || 0;
    const grandTotal = subTotal + totalGST - finalDiscount;
    const billNo = `INV-${Date.now().toString().slice(-6)}`;
    const billDate = new Date().toISOString().split("T")[0];
    const billTime = new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    });

    // 3. Save Bill
    await pool.query(
      `INSERT INTO bill_history (hotel_id, bill_no, bill_type, location, items_json, total, sub_total, gst_amount, payment_mode, bill_date, bill_time) 
       VALUES ($1, $2, 'DINE-IN', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        req.hotel_id,
        billNo,
        table_no,
        JSON.stringify(items),
        grandTotal,
        subTotal,
        totalGST,
        payment_mode || "CASH",
        billDate,
        billTime,
      ],
    );

    // 4. Cleanup
    await pool.query(
      "DELETE FROM kitchen_orders WHERE hotel_id = $1 AND (room_no = $2 OR location = $2)",
      [req.hotel_id, table_no],
    );
    await pool.query(
      "UPDATE tables SET status='AVAILABLE' WHERE hotel_id = $1 AND table_no = $2",
      [req.hotel_id, table_no],
    );

    res.json({
      success: true,
      message: "Bill Settled Successfully ✅",
      bill_no: billNo,
      bill_amount: grandTotal,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📊 11. DASHBOARD & REPORTS API
// ==========================================
app.get("/dashboard_stats", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const stats = {
    occupied_rooms: 0,
    active_tables: 0,
    pending_orders: 0,
    revenue: 0,
  };

  try {
    const rooms = await pool.query(
      "SELECT COUNT(*) FROM rooms WHERE hotel_id = $1 AND status='OCCUPIED'",
      [req.hotel_id],
    );
    stats.occupied_rooms = parseInt(rooms.rows[0].count);

    const tables = await pool.query(
      "SELECT COUNT(*) FROM tables WHERE hotel_id = $1 AND status='OCCUPIED'",
      [req.hotel_id],
    );
    stats.active_tables = parseInt(tables.rows[0].count);

    const orders = await pool.query(
      "SELECT COUNT(*) FROM kitchen_orders WHERE hotel_id = $1 AND status='PENDING'",
      [req.hotel_id],
    );
    stats.pending_orders = parseInt(orders.rows[0].count);

    const revenue = await pool.query(
      "SELECT SUM(total) FROM bill_history WHERE hotel_id = $1 AND bill_date = $2",
      [req.hotel_id, today],
    );
    stats.revenue = parseFloat(revenue.rows[0].sum) || 0;

    res.json(stats);
  } catch (err) {
    res.status(500).json(stats);
  }
});

// Get Daily Bills Report
app.get("/api/reports/daily_bills", async (req, res) => {
  const { date } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM bill_history WHERE hotel_id = $1 AND bill_date = $2 ORDER BY id DESC",
      [req.hotel_id, date],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Health Check for Render
app.get("/", (req, res) => {
  res.send("<h1>🚀 HotelOS Master Cloud API is LIVE!</h1>");
});

app.listen(PORT, () => {
  console.log(`✅ Master Server running on port ${PORT}`);
});
