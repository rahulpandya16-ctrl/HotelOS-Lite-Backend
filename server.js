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

// ==========================================
// 📦 12. INVENTORY & VENDORS API
// ==========================================

app.get("/api/inventory", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM inventory_items WHERE hotel_id = $1 ORDER BY item_name ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get("/api/vendors", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM vendors WHERE hotel_id = $1 ORDER BY name ASC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post("/api/inventory/add", async (req, res) => {
  const {
    item_id,
    quantity,
    vendor_id,
    price_per_unit,
    gst_percent,
    gst_amount,
    total_bill_amount,
  } = req.body;
  const date = new Date().toISOString().split("T")[0];

  try {
    await pool.query("BEGIN"); // Transaction Start

    // 1. Stock Update
    await pool.query(
      "UPDATE inventory_items SET current_stock = current_stock + $1, price_per_unit = $2 WHERE id = $3 AND hotel_id = $4",
      [quantity, price_per_unit, item_id, req.hotel_id],
    );

    // 2. Vendor Balance Update
    await pool.query(
      "UPDATE vendors SET balance = balance + $1 WHERE id = $2 AND hotel_id = $3",
      [total_bill_amount || quantity * price_per_unit, vendor_id, req.hotel_id],
    );

    // 3. Stock Log
    await pool.query(
      `INSERT INTO stock_logs (hotel_id, item_id, type, quantity, price_at_time, vendor_id, date, remarks, gst_percent, gst_amount, total_bill_amount) 
       VALUES ($1, $2, 'IN', $3, $4, $5, $6, 'Purchase', $7, $8, $9)`,
      [
        req.hotel_id,
        item_id,
        quantity,
        price_per_unit,
        vendor_id,
        date,
        gst_percent || 0,
        gst_amount || 0,
        total_bill_amount || quantity * price_per_unit,
      ],
    );

    await pool.query("COMMIT");
    res.json({ success: true, message: "Purchase Saved!" });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inventory/consume", async (req, res) => {
  const { item_id, quantity, remarks } = req.body;
  const date = new Date().toISOString().split("T")[0];

  try {
    await pool.query(
      "UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id = $2 AND hotel_id = $3",
      [quantity, item_id, req.hotel_id],
    );
    await pool.query(
      "INSERT INTO stock_logs (hotel_id, item_id, type, quantity, date, remarks) VALUES ($1, $2, 'OUT', $3, $4, $5)",
      [req.hotel_id, item_id, quantity, date, remarks || "Kitchen Use"],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💸 13. EXPENSES & PETTY CASH (CA MODULE)
// ==========================================

app.post("/api/expenses/add", async (req, res) => {
  const { date, category, amount, payment_mode, remarks, added_by } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO expenses (hotel_id, date, category, amount, payment_mode, remarks, added_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        req.hotel_id,
        date,
        category,
        amount,
        payment_mode || "CASH",
        remarks || "",
        added_by || "Admin",
      ],
    );
    res.json({
      success: true,
      message: "Expense Added Successfully!",
      id: result.rows[0].id,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/expenses", async (req, res) => {
  const { from, to } = req.query;
  try {
    let sql =
      "SELECT * FROM expenses WHERE hotel_id = $1 ORDER BY date DESC, id DESC LIMIT 500";
    let params = [req.hotel_id];

    if (from && to) {
      sql =
        "SELECT * FROM expenses WHERE hotel_id = $1 AND date >= $2 AND date <= $3 ORDER BY date DESC, id DESC";
      params = [req.hotel_id, from, to];
    }
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// ==========================================
// 🛠️ 14. ADVANCED TABLES (Auto-Setup)
// ==========================================
async function initializeAdvancedTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), item_name TEXT, item_name_local TEXT DEFAULT '',
      category TEXT, unit TEXT, current_stock REAL, min_stock_level REAL, price_per_unit REAL DEFAULT 0, gst_rate REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), name TEXT, mobile TEXT, address TEXT, gst_number TEXT, balance REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stock_logs (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), item_id INTEGER, type TEXT, quantity REAL, price_at_time REAL, 
      vendor_id INTEGER, date TEXT, remarks TEXT, gst_percent REAL DEFAULT 0, gst_amount REAL DEFAULT 0, total_bill_amount REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), staff_id INTEGER, name TEXT, date TEXT, in_time TEXT, out_time TEXT, status TEXT, selfie_path TEXT
    );
    CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), staff_id INTEGER, month_year TEXT, base_salary REAL, 
      present_days REAL, earned_amount REAL, advance_deducted REAL, final_payout REAL, payment_date TEXT
    );
    CREATE TABLE IF NOT EXISTS staff_advances (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), staff_id INTEGER, amount REAL, date TEXT, reason TEXT, paid INTEGER DEFAULT 0, is_deducted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), name TEXT, mobile TEXT UNIQUE, address TEXT, aadhar TEXT, id_proof TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS client_history (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), client_mobile TEXT, type TEXT, details TEXT, amount REAL, date TEXT
    );
    CREATE TABLE IF NOT EXISTS delivery_partners (
      id SERIAL PRIMARY KEY, hotel_id VARCHAR(100), name TEXT UNIQUE, api_key TEXT, status INTEGER DEFAULT 1
    );
  `;
  try {
    await pool.query(sql);
    console.log("✅ Advanced Tables (HR, Inventory, Clients) Created!");
  } catch (err) {
    console.error("❌ Advanced Table Error:", err.message);
  }
}
initializeAdvancedTables();

// ==========================================
// 👨‍💼 15. STAFF, ATTENDANCE & PAYROLL
// ==========================================

// Time calculation helper for Salary
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(" ");
  const [time, modifier] = parts;
  if (!time) return 0;
  let [hours, minutes] = time.split(":");
  hours = parseInt(hours);
  minutes = parseInt(minutes);
  if (parts.length > 1) {
    if (hours === 12) hours = 0;
    if (modifier === "PM") hours += 12;
  }
  return hours * 60 + minutes;
}

app.post("/api/mark_attendance", async (req, res) => {
  const { staff_id } = req.body;
  const date = new Date().toISOString().split("T")[0];
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  try {
    const userRes = await pool.query(
      "SELECT name FROM users WHERE id = $1 AND hotel_id = $2",
      [staff_id, req.hotel_id],
    );
    if (userRes.rows.length === 0)
      return res.json({ status: false, message: "User not found" });

    const user = userRes.rows[0];
    const attRes = await pool.query(
      "SELECT * FROM attendance WHERE staff_id = $1 AND date = $2 AND hotel_id = $3",
      [staff_id, date, req.hotel_id],
    );

    if (attRes.rows.length === 0) {
      // Clock IN
      await pool.query(
        "INSERT INTO attendance (hotel_id, staff_id, name, date, in_time, status) VALUES ($1, $2, $3, $4, $5, 'P')",
        [req.hotel_id, staff_id, user.name, date, time],
      );
      res.json({
        status: true,
        type: "IN",
        message: `✅ Clocked In at ${time}`,
      });
    } else {
      // Clock OUT
      const record = attRes.rows[0];
      if (!record.out_time) {
        await pool.query("UPDATE attendance SET out_time = $1 WHERE id = $2", [
          time,
          record.id,
        ]);
        res.json({
          status: true,
          type: "OUT",
          message: `🛑 Clocked Out at ${time}`,
        });
      } else {
        res.json({ status: false, message: "⚠️ Already Clocked Out today!" });
      }
    }
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
});

app.get("/api/attendance_history", async (req, res) => {
  const { month, staff_id } = req.query;
  try {
    let sql =
      "SELECT * FROM attendance WHERE hotel_id = $1 AND date LIKE $2 ORDER BY date DESC";
    let params = [req.hotel_id, `${month}%`];

    if (staff_id && staff_id !== "null") {
      sql =
        "SELECT * FROM attendance WHERE hotel_id = $1 AND date LIKE $2 AND staff_id = $3 ORDER BY date DESC";
      params.push(staff_id);
    }
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post("/api/add_advance", async (req, res) => {
  const { staff_id, amount, date, reason } = req.body;
  try {
    await pool.query(
      "INSERT INTO staff_advances (hotel_id, staff_id, amount, date, reason) VALUES ($1, $2, $3, $4, $5)",
      [req.hotel_id, staff_id, amount, date, reason || "Advance"],
    );
    res.json({ status: true, message: "Advance Added" });
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
});

app.get("/api/calculate_salary", async (req, res) => {
  const { staff_id, month } = req.query;
  try {
    // 1. Get Settings for working hours
    const settingsRes = await pool.query(
      "SELECT full_day_hours, half_day_hours FROM hotel_settings WHERE hotel_id = $1",
      [req.hotel_id],
    );
    const fullDayHours =
      settingsRes.rows.length > 0 ? settingsRes.rows[0].full_day_hours : 9;
    const halfDayHours =
      settingsRes.rows.length > 0 ? settingsRes.rows[0].half_day_hours : 4;

    // 2. Get User Salary
    const userRes = await pool.query(
      "SELECT * FROM users WHERE id = $1 AND hotel_id = $2",
      [staff_id, req.hotel_id],
    );
    if (userRes.rows.length === 0) return res.json(null);
    const user = userRes.rows[0];
    const oneDaySalary = (user.salary || 0) / 30;

    // 3. Get Attendance Records
    const attRes = await pool.query(
      "SELECT in_time, out_time FROM attendance WHERE staff_id = $1 AND date LIKE $2 AND hotel_id = $3",
      [staff_id, `${month}%`, req.hotel_id],
    );

    let totalPresentDays = 0;
    attRes.rows.forEach((row) => {
      if (row.in_time && row.out_time) {
        const duration =
          (parseTime(row.out_time) - parseTime(row.in_time)) / 60; // in hours
        if (duration >= fullDayHours) totalPresentDays += 1;
        else if (duration >= halfDayHours) totalPresentDays += 0.5;
      }
    });

    // 4. Get Advances
    const advRes = await pool.query(
      "SELECT SUM(amount) as total FROM staff_advances WHERE staff_id = $1 AND is_deducted = 0 AND hotel_id = $2",
      [staff_id, req.hotel_id],
    );
    const totalAdvance = parseFloat(advRes.rows[0].total) || 0;

    const earned = Math.round(totalPresentDays * oneDaySalary);
    const finalPayout = earned - totalAdvance;

    res.json({
      month: month,
      base_salary: user.salary,
      present_days: totalPresentDays,
      earned_amount: earned,
      advance_deducted: totalAdvance,
      final_payout: finalPayout > 0 ? finalPayout : 0,
    });
  } catch (err) {
    res.json(null);
  }
});

app.post("/api/finalize_salary", async (req, res) => {
  const {
    staff_id,
    month,
    base_salary,
    present_days,
    earned_amount,
    advance_deducted,
    final_payout,
  } = req.body;
  try {
    await pool.query("BEGIN");

    await pool.query(
      `INSERT INTO payroll (hotel_id, staff_id, month_year, base_salary, present_days, earned_amount, advance_deducted, final_payout, payment_date) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.hotel_id,
        staff_id,
        month,
        base_salary,
        present_days,
        earned_amount,
        advance_deducted,
        final_payout,
        new Date().toISOString().split("T")[0],
      ],
    );

    await pool.query(
      "UPDATE staff_advances SET is_deducted = 1 WHERE staff_id = $1 AND is_deducted = 0 AND hotel_id = $2",
      [staff_id, req.hotel_id],
    );

    await pool.query("COMMIT");
    res.json({ status: true, message: "Salary Paid & Recorded!" });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.json({ status: false, message: err.message });
  }
});

// ==========================================
// 👥 16. CLIENT MANAGEMENT API
// ==========================================
app.get("/clients", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM clients WHERE hotel_id = $1 ORDER BY id DESC",
      [req.hotel_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/save_client", async (req, res) => {
  const { name, mobile, address, aadhar } = req.body;
  try {
    const check = await pool.query(
      "SELECT id FROM clients WHERE mobile = $1 AND hotel_id = $2",
      [mobile, req.hotel_id],
    );
    if (check.rows.length > 0) {
      await pool.query(
        "UPDATE clients SET name=$1, address=$2, aadhar=$3 WHERE mobile=$4 AND hotel_id=$5",
        [name, address, aadhar, mobile, req.hotel_id],
      );
    } else {
      await pool.query(
        "INSERT INTO clients (hotel_id, name, mobile, address, aadhar) VALUES ($1, $2, $3, $4, $5)",
        [req.hotel_id, name, mobile, address, aadhar],
      );
    }
    res.json({ message: "Client Saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/client_history", async (req, res) => {
  const mobile = req.query.mobile;
  if (!mobile) return res.json([]);
  try {
    const query = `
      SELECT bill_no, bill_date as date, bill_time, total as amount, bill_type as type, 
      location as room_no, check_in, guests_json as other_guests, items_json as items_summary 
      FROM bill_history WHERE mobile = $1 AND hotel_id = $2 ORDER BY id DESC
    `;
    const result = await pool.query(query, [mobile, req.hotel_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 📊 17. TALLY XML EXPORT (CA SPECIAL)
// ==========================================
app.get("/api/export/tally", async (req, res) => {
  const { from, to } = req.query;

  try {
    const salesRes = await pool.query(
      "SELECT * FROM bill_history WHERE hotel_id = $1 AND bill_date >= $2 AND bill_date <= $3",
      [req.hotel_id, from, to],
    );
    const expRes = await pool.query(
      "SELECT * FROM expenses WHERE hotel_id = $1 AND date >= $2 AND date <= $3",
      [req.hotel_id, from, to],
    );

    let xml = `<ENVELOPE>\n<HEADER>\n<TALLYREQUEST>Import Data</TALLYREQUEST>\n</HEADER>\n<BODY>\n<IMPORTDATA>\n<REQUESTDESC>\n<REPORTNAME>Vouchers</REPORTNAME>\n</REQUESTDESC>\n<REQUESTDATA>\n`;

    // Sales XML
    salesRes.rows.forEach((sale) => {
      let cleanDate = sale.bill_date ? sale.bill_date.replace(/-/g, "") : "";
      xml += `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n<VOUCHER VCHTYPE="Sales" ACTION="Create">\n`;
      xml += `<DATE>${cleanDate}</DATE>\n`;
      xml += `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>\n`;
      xml += `<VOUCHERNUMBER>${sale.bill_no}</VOUCHERNUMBER>\n`;
      xml += `<PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>\n`;
      xml += `<ALLLEDGERENTRIES.LIST>\n<LEDGERNAME>Sales Account</LEDGERNAME>\n<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n<AMOUNT>${sale.total}</AMOUNT>\n</ALLLEDGERENTRIES.LIST>\n`;
      xml += `</VOUCHER>\n</TALLYMESSAGE>\n`;
    });

    // Expenses XML
    expRes.rows.forEach((exp) => {
      let cleanDate = exp.date ? exp.date.replace(/-/g, "") : "";
      xml += `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n<VOUCHER VCHTYPE="Payment" ACTION="Create">\n`;
      xml += `<DATE>${cleanDate}</DATE>\n`;
      xml += `<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>\n`;
      xml += `<PARTYLEDGERNAME>${exp.category}</PARTYLEDGERNAME>\n`;
      xml += `<ALLLEDGERENTRIES.LIST>\n<LEDGERNAME>Cash</LEDGERNAME>\n<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n<AMOUNT>${exp.amount}</AMOUNT>\n</ALLLEDGERENTRIES.LIST>\n`;
      xml += `</VOUCHER>\n</TALLYMESSAGE>\n`;
    });

    xml += `</REQUESTDATA>\n</IMPORTDATA>\n</BODY>\n</ENVELOPE>`;

    res.header("Content-Type", "application/xml");
    res.attachment(`Tally_Export_${from}_to_${to}.xml`);
    res.send(xml);
  } catch (err) {
    res.status(500).send("Database Error");
  }
});

// ==========================================
// 🤖 18. AI ANALYTICS & INSIGHTS
// ==========================================
app.get("/api/analytics/ai-insights", async (req, res) => {
  let insights = [];
  const today = new Date().toISOString().split("T")[0];

  try {
    // 1. Trending Item
    const topRes = await pool.query(
      "SELECT item_name, SUM(qty) as total_qty FROM kitchen_orders WHERE hotel_id = $1 AND order_date = $2 GROUP BY item_name ORDER BY total_qty DESC LIMIT 1",
      [req.hotel_id, today],
    );
    if (topRes.rows.length > 0) {
      insights.push({
        type: "success",
        text: `🚀 Trending: '${topRes.rows[0].item_name}' is your best seller today.`,
      });
    }

    // 2. High Expense Alert
    const expRes = await pool.query(
      "SELECT SUM(amount) as total_exp FROM expenses WHERE hotel_id = $1 AND date = $2",
      [req.hotel_id, today],
    );
    if (expRes.rows[0].total_exp > 1000) {
      insights.push({
        type: "warning",
        text: `⚠️ Alert: Today's expenses are high (₹${expRes.rows[0].total_exp}).`,
      });
    }

    // 3. Pending Orders
    const penRes = await pool.query(
      "SELECT COUNT(*) as count FROM kitchen_orders WHERE hotel_id = $1 AND status = 'PENDING'",
      [req.hotel_id],
    );
    const pending = parseInt(penRes.rows[0].count);
    if (pending > 5) {
      insights.push({
        type: "danger",
        text: `⏳ Speed Up: ${pending} orders waiting in kitchen!`,
      });
    } else if (pending === 0) {
      insights.push({
        type: "success",
        text: `✅ Kitchen is clear. Good job team!`,
      });
    }

    if (insights.length === 0) {
      insights.push({ type: "success", text: `🌟 System running smoothly.` });
    }
    res.json({ success: true, insights: insights });
  } catch (err) {
    res.json({
      success: false,
      insights: [{ type: "success", text: `🌟 System running smoothly.` }],
    });
  }
});

// ==========================================
// 📊 19. EXCEL REPORT GENERATOR
// ==========================================
const ExcelJS = require("exceljs");

app.post("/api/generate-excel-report", async (req, res) => {
  try {
    const { data, type } = req.body;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Report");

    if (data.length > 0) {
      // Generate Headers dynamically from the first object
      const headers = Object.keys(data[0]).map((key) => ({
        header: key.toUpperCase(),
        key: key,
        width: 20,
      }));
      worksheet.columns = headers;

      // Add Data
      data.forEach((item) => worksheet.addRow(item));
      worksheet.getRow(1).font = { bold: true };
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${type}_Report.xlsx`,
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: "Excel Generation Failed" });
  }
});

// ==========================================
// 🛵 20. ZOMATO / SWIGGY & OTA WEBHOOKS
// ==========================================
app.post("/api/delivery_partners/save", async (req, res) => {
  const { name, api_key, status } = req.body;
  const cleanName = name.trim().toUpperCase();
  try {
    await pool.query(
      `INSERT INTO delivery_partners (hotel_id, name, api_key, status) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET api_key = EXCLUDED.api_key, status = EXCLUDED.status`,
      [req.hotel_id, cleanName, api_key, status],
    );
    res.json({ success: true, message: "Partner Saved" });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/ota/webhook", async (req, res) => {
  const {
    ota_name,
    guest_name,
    check_in,
    check_out,
    room_type,
    total_price,
    hotel_id,
  } = req.body;
  const targetHotel = hotel_id || req.hotel_id; // Webhook bahar se aayega, usme hotel_id zaroor hona chahiye!

  if (!targetHotel)
    return res.status(403).json({ error: "Missing hotel_id in webhook" });

  try {
    await pool.query(
      `INSERT INTO advance_bookings (hotel_id, room_no, guest_name, mobile, check_in_date, check_out_date, advance_amount, status) 
       VALUES ($1, 'TBD', $2, 'OTA Booking', $3, $4, $5, 'CONFIRMED')`,
      [targetHotel, guest_name, check_in, check_out, total_price],
    );
    res.json({ status: "success", message: "OTA Booking Saved!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🔐 SUBSCRIPTION & LICENSE CHECK API
// ==========================================
app.get("/api/check-license", async (req, res) => {
  // Client app yahan apna hotel_id bhejega
  const clientHotelId = req.hotel_id;

  try {
    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE hotel_id = $1",
      [clientHotelId],
    );

    if (result.rows.length === 0) {
      return res.json({
        status: "expired",
        warning: "❌ Invalid Hotel ID! Contact Admin.",
        days_left: 0,
      });
    }

    const sub = result.rows[0];
    const today = new Date();
    const expiry = new Date(sub.expiry_date);
    const diffTime = expiry - today;
    const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysLeft < 0 || sub.status === "INACTIVE") {
      return res.json({
        status: "expired",
        warning: "❌ Software License Expired! Please Renew.",
        days_left: 0,
      });
    }

    // Sab theek hai! App chalu rakho.
    res.json({
      status: "active",
      days_left: daysLeft,
      expiry_date: sub.expiry_date,
      warning: daysLeft < 7 ? `⚠️ License expires in ${daysLeft} days!` : "",
    });
  } catch (err) {
    res.json({ status: "expired", warning: "Server Error checking license." });
  }
});

// ==========================================
// 🚀 EMERGENCY MAGIC SETUP (Bypass Supabase SQL Error)
// ==========================================
app.get("/setup-demo-data", async (req, res) => {
  try {
    // 1. License Table banayega aur aapka ID active karega
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        hotel_id VARCHAR(100) PRIMARY KEY,
        expiry_date DATE,
        status VARCHAR(20) DEFAULT 'ACTIVE'
      );
    `);

    await pool.query(`
      INSERT INTO subscriptions (hotel_id, expiry_date) 
      VALUES ('HOTEL_INDORE_1728', '2027-03-10')
      ON CONFLICT (hotel_id) DO UPDATE SET expiry_date = '2027-03-10';
    `);

    // 2. Puraana khali data saaf karega
    await pool.query(`DELETE FROM rooms WHERE hotel_id = 'HOTEL_INDORE_1728'`);
    await pool.query(`DELETE FROM tables WHERE hotel_id = 'HOTEL_INDORE_1728'`);

    // 3. Naye Rooms dalega
    await pool.query(`
      INSERT INTO rooms (hotel_id, room_no, type, price, status) VALUES 
      ('HOTEL_INDORE_1728', '101', 'AC', 2000, 'VACANT'),
      ('HOTEL_INDORE_1728', '102', 'Non-AC', 1500, 'VACANT'),
      ('HOTEL_INDORE_1728', '103', 'Deluxe', 3000, 'VACANT');
    `);

    // 4. Nayi Tables dalega
    await pool.query(`
      INSERT INTO tables (hotel_id, table_no, status) VALUES 
      ('HOTEL_INDORE_1728', 'T1', 'AVAILABLE'),
      ('HOTEL_INDORE_1728', 'T2', 'AVAILABLE'),
      ('HOTEL_INDORE_1728', 'P-1', 'AVAILABLE');
    `);

    res.send(
      "<h1 style='color:green; text-align:center; margin-top:50px;'>✅ SUCCESS! Saara data apne aap set ho gaya! Ab apna Mobile App open karo.</h1>",
    );
  } catch (err) {
    res.send(
      "<h1 style='color:red; text-align:center; margin-top:50px;'>❌ Error: " +
        err.message +
        "</h1>",
    );
  }
});

// Health Check for Render
app.get("/", (req, res) => {
  res.send("<h1>🚀 HotelOS Master Cloud API is LIVE!</h1>");
});

app.listen(PORT, () => {
  console.log(`✅ Master Server running on port ${PORT}`);
});
