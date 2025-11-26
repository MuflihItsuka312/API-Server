// server.js - Smart Locker Backend + Mongoose + Auth Customer
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// === ENV ===
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/smartlocker";
const BINDER_KEY = process.env.BINDERBYTE_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "supersecret-key-for-dev";

// === KONEKSI MONGODB ===
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// === SCHEMA & MODEL ===
const { Schema, model } = mongoose;

/**
 * USER (customer / agent)
 * - sekarang ada email, phone, role
 * - disimpan di koleksi "customer_users" (biar cocok dengan yang sudah ada)
 */
const userSchema = new Schema(
  {
    userId: { type: String, unique: true },
    name: String,
    email: { type: String, unique: true, sparse: true },
    phone: String,
    passwordHash: String,
    role: { type: String, default: "customer" }, // customer / agent / admin
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
const User = model("User", userSchema, "customer_users");

/**
 * Shipment (paket per resi)
 */
const shipmentSchema = new Schema(
  {
    resi: { type: String, required: true },
    lockerId: { type: String, required: true },
    courierType: { type: String, required: true },

    receiverName: { type: String },
    receiverPhone: { type: String },
    customerId: { type: String },
    itemType: { type: String },

    courierPlate: { type: String },          // ⬅️ sudah ada
    // ⬇️ tambah ini
    courierName: { type: String },           // nama kurir (diisi dari login)

    status: { type: String, default: "assigned_to_locker" },
    createdAt: { type: Date, default: Date.now },

    // ⬇️ biar shipment.logs.push(...) nggak error & ke-save
    logs: {
      type: [
        {
          event: String,
          lockerId: String,
          resi: String,
          timestamp: Date,
          extra: Schema.Types.Mixed,
        },
      ],
      default: [],
    },

    deliveredToLockerAt: { type: Date },
    pickedUpAt: { type: Date },
  },
  { versionKey: false }
);

const Shipment = model("Shipment", shipmentSchema, "shipments");

/**
 * Locker (per kotak fisik)
 */
// Model Locker (pastikan collection: 'lockers')

const lockerSchema = new Schema(
  {
    lockerId: { type: String, required: true, unique: true },
    lockerToken: { type: String, default: null },
    pendingResi: { type: [String], default: [] },
    command: { type: Schema.Types.Mixed, default: null },
    isActive: { type: Boolean, default: true },
    status: { type: String, default: "unknown" },
    tokenUpdatedAt: { type: Date },
    lastHeartbeat: { type: Date },
  },
  {
    collection: "lockers", // PENTING: sama persis dengan di Compass
  }
);

const Locker = model("Locker", lockerSchema);

// Endpoint: GET /api/lockers
app.get("/api/lockers", async (req, res) => {
  try {
    const lockers = await Locker.find({}).lean();
    res.json({ data: lockers });
  } catch (err) {
    console.error("GET /api/lockers error:", err);
    res.status(500).json({ error: "Failed to fetch lockers" });
  }
});

/**
 * LockerLog (optional, untuk audit)
 */
const lockerLogSchema = new Schema(
  {
    lockerId: String,
    resi: String,
    action: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
const LockerLog = model("LockerLog", lockerLogSchema, "locker_logs");


//locker-
// ====== In-Memory Lockers (atau nanti bisa pakai Mongo) ======
const lockers = {};  // key: lockerId -> value: locker object

function getLocker(lockerId) {
  if (!lockers[lockerId]) {
    lockers[lockerId] = {
      lockerId,
      lockerToken: `LK-${lockerId}-${Math.random().toString(36).slice(2, 8)}`,
      pendingResi: [],
      command: null,
      active: true,
      lastHeartbeat: null,
    };
  }
  return lockers[lockerId];
}

// GET semua locker (Locker Client Pool)
app.get("/api/lockers", (req, res) => {
  const list = Object.values(lockers).map((l) => ({
    lockerId: l.lockerId,
    lockerToken: l.lockerToken,
    pendingCount: Array.isArray(l.pendingResi) ? l.pendingResi.length : 0,
    active: l.active !== false,
    lastHeartbeat: l.lastHeartbeat || null,
  }));
  res.json({ data: list });
});

// GET detail locker
app.get("/api/lockers/:lockerId", (req, res) => {
  const lockerId = req.params.lockerId;
  const locker = lockers[lockerId];
  if (!locker) return res.status(404).json({ error: "Locker not found" });

  res.json({ data: locker });
});

// Helper untuk dapat locker, auto-create kalau belum ada
async function getLocker(lockerId) {
  let locker = await Locker.findOne({ lockerId });
  if (!locker) {
    locker = await Locker.create({
      lockerId,
      lockerToken: `LK-${lockerId}-${Math.random().toString(36).slice(2, 8)}`,
      pendingResi: [],
      command: null,
    });
  }
  return locker;
}

// === AUTH MIDDLEWARE ===
function auth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: "Token missing" });

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// === ENDPOINTS ===

// 0. Health check
app.get("/", (req, res) => {
  res.send("Smart Locker backend with MongoDB is running ✅");
});

// === AUTH ENDPOINTS (Customer) ===

// Register customer
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email dan password wajib diisi" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email sudah terdaftar" });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = await User.create({
      userId: "cus_" + Date.now(),
      name,
      email,
      phone,
      passwordHash: hash,
      role: "customer",
    });

    res.json({ message: "Registrasi berhasil", userId: user.userId });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Gagal registrasi" });
  }
});

// Login customer
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ error: "Email tidak ditemukan" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Password salah" });

    const token = jwt.sign(
      { userId: user.userId, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login sukses",
      token,
      userId: user.userId,
      name: user.name,
    });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "Gagal login" });
  }
});

// === AGENT ENDPOINTS ===

// 1) Agent input paket (bisa banyak resi sekaligus)
app.post("/api/shipments", async (req, res) => {
  try {
    const {
      lockerId,
      courierType, // utama
      resiList,
      receiverName,
      receiverPhone,
      customerId,
      itemType,
      courierPlate, // dari front-end
      courierLabel, // label kurir opsional
      courierId,
    } = req.body;

    if (!lockerId || !courierType || !Array.isArray(resiList) || resiList.length === 0) {
      return res.status(400).json({ error: "lockerId, courierType, resiList wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    // Jika user memilih courierId dari pool, coba ambil nama kurir
    let courierName = courierLabel || "";
    if (courierId) {
      try {
        const c = await Courier.findOne({ courierId });
        if (c && c.name) courierName = c.name;
      } catch (e) {
        // ignore
      }
    }

    const createdShipments = [];

    for (const resi of resiList) {
      // hindari duplikasi: jika sudah ada shipment aktif untuk resi, skip pembuatan baru
      const exists = await Shipment.findOne({ resi });
      if (exists) {
        // tambahkan ke pendingResi locker jika belum ada dan status belum selesai
        if (
          !locker.pendingResi.includes(resi) &&
          exists.status !== "completed" &&
          exists.status !== "delivered_to_locker"
        ) {
          locker.pendingResi.push(resi);
        }
        createdShipments.push(exists);
        continue;
      }

      const sh = await Shipment.create({
        resi,
        courierType,
        lockerId,
        receiverName: receiverName || "Customer Demo",
        receiverPhone: receiverPhone || "",
        customerId: customerId || "",
        itemType: itemType || "",
        courierPlate: courierPlate || "",
        courierName: courierName || "",
        status: "pending_locker",
        createdAt: new Date(),
        logs: [
          {
            event: "assigned_to_locker",
            lockerId,
            resi,
            timestamp: new Date(),
            extra: { source: "agent" },
          },
        ],
      });

      createdShipments.push(sh);

      if (!locker.pendingResi.includes(resi)) {
        locker.pendingResi.push(resi);
      }
    }

    await locker.save();

    return res.json({ message: "Shipments assigned to locker", locker, shipments: createdShipments });
  } catch (err) {
    console.error("POST /api/shipments error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// List semua shipments (untuk Agent dashboard)
app.get("/api/shipments", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);

    const shipments = await Shipment.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ data: shipments });
  } catch (err) {
    console.error("GET /api/shipments error:", err);
    res.status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// Validasi resi via Binderbyte (untuk Agent)
app.get("/api/validate-resi", async (req, res) => {
  try {
    const { courier, resi } = req.query;

    if (!courier || !resi) {
      return res
        .status(400)
        .json({ valid: false, error: "courier dan resi wajib diisi" });
    }

    if (!BINDER_KEY) {
      return res.status(500).json({
        valid: false,
        error: "BINDERBYTE_API_KEY belum dikonfigurasi",
      });
    }

    const url = "https://api.binderbyte.com/v1/track";
    const response = await axios.get(url, {
      params: {
        api_key: BINDER_KEY,
        courier,
        awb: resi,
      },
    });

    return res.json({
      valid: true,
      data: response.data,
    });
  } catch (err) {
    console.error("validate-resi error:", err.response?.data || err.message);

    const status = err.response?.status || 500;
    if (status === 400 || status === 404) {
      return res.json({
        valid: false,
        error: "Resi tidak ditemukan atau tidak valid",
      });
    }

    return res.status(500).json({
      valid: false,
      error: "Gagal menghubungi layanan tracking",
    });
  }
});

// === CUSTOMER ENDPOINTS ===

// List semua shipment milik customer (pakai JWT, tidak perlu input no HP)
app.get("/api/customer/shipments", auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const shipments = await Shipment.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ data: shipments });
  } catch (err) {
    console.error("GET /api/customer/shipments error:", err);
    res.status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// Customer minta buka locker untuk resi tertentu (pakai JWT)
app.post("/api/customer/open-locker", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { resi, courierType } = req.body;

    if (!resi || !courierType) {
      return res
        .status(400)
        .json({ error: "resi dan courierType wajib diisi" });
    }

    const shipment = await Shipment.findOne({
      resi,
      courierType,
      customerId: userId,
    });

    if (!shipment) {
      return res
        .status(404)
        .json({ error: "Shipment tidak ditemukan untuk user ini" });
    }

    const locker = await Locker.findOneAndUpdate(
      { lockerId: shipment.lockerId },
      { command: { type: "open", resi, source: "customer", createdAt: new Date() } },
      { new: true }
    );

    if (!locker) {
      return res
        .status(404)
        .json({ error: "Locker tidak ditemukan untuk shipment ini" });
    }

    await LockerLog.create({
      lockerId: locker.lockerId,
      resi,
      action: "customer_open_request",
      at: new Date(),
    });

    res.json({
      message: "Permintaan buka loker dikirim ke ESP32",
      lockerId: locker.lockerId,
    });
  } catch (err) {
    console.error("POST /api/customer/open-locker error:", err);
    res.status(500).json({
      error: "Gagal mengirim permintaan buka loker",
      detail: err.message,
    });
  }
});

// Detail tracking 1 resi (Binderbyte + internal) - bisa tanpa auth
app.get("/api/customer/track/:resi", async (req, res) => {
  const { resi } = req.params;
  const { courier } = req.query;

  if (!courier) {
    return res.status(400).json({ error: "courier wajib diisi" });
  }

  try {
    const shipment = await Shipment.findOne({ resi }).lean();

    const bbResp = await axios.get("https://api.binderbyte.com/v1/track", {
      params: {
        api_key: BINDER_KEY,
        courier,
        awb: resi,
      },
    });

    res.json({
      shipment,
      binderbyte: bbResp.data,
    });
  } catch (err) {
    console.error("GET /api/customer/track error:", err.response?.data || err);
    res.status(500).json({
      error: "Gagal mengambil data tracking",
      detail: err.response?.data || err.message,
    });
  }
});

// === KURIR LOGIN ===
// Kurir login pakai nama + plat.
// Hanya berhasil kalau ada minimal 1 shipment pending_locker dengan courierPlate tsb.

// === COURIER MODEL ===
const courierSchema = new Schema(
  {
    courierId: { type: String, unique: true },   // mis: "CR-ANT-01"
    name: { type: String, required: true },      // nama kurir: "Mas Budi"
    company: { type: String, required: true },   // "anteraja", "jne", dll
    plate: { type: String, required: true },     // "B 1234 CD" (UPPERCASE)
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

const Courier = model("Courier", courierSchema, "couriers");
// GET /api/couriers
app.get("/api/couriers", async (req, res) => {
  try {
    const couriers = await Courier.find({}).sort({ company: 1, name: 1 }).lean();
    res.json({ data: couriers });
  } catch (err) {
    console.error("GET /api/couriers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Tambah kurir baru
app.post("/api/couriers", async (req, res) => {
  try {
    let { name, company, plate } = req.body;

    if (!name || !company || !plate) {
      return res
        .status(400)
        .json({ error: "name, company, dan plate wajib diisi" });
    }

    name = name.trim();
    company = company.trim().toLowerCase();
    plate = plate.trim().toUpperCase();

    const exists = await Courier.findOne({ plate, company });
    if (exists) {
      return res.status(400).json({
        error: "Kurir dengan plat & perusahaan ini sudah terdaftar",
      });
    }

    const courier = await Courier.create({
      courierId: "CR-" + company.toUpperCase().slice(0, 3) + "-" + Date.now(),
      name,
      company,
      plate,
    });

    res.json({ message: "Kurir berhasil ditambahkan", courier });
  } catch (err) {
    console.error("POST /api/couriers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// courier login: gunakan koleksi couriers
app.post("/api/courier/login", async (req, res) => {
  try {
    const { name, plate } = req.body;
    if (!name || !plate) {
      return res.status(400).json({ error: "name dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    const courier = await Courier.findOne({ plate: normalizedPlate, active: true });
    if (!courier) {
      return res.status(401).json({ error: "Kurir tidak terdaftar. Hubungi admin." });
    }

    // Optional: cocokan nama (case-insensitive)
    if (courier.name.toLowerCase() !== name.trim().toLowerCase()) {
      return res.status(401).json({ error: "Nama kurir tidak sesuai" });
    }

    // Pastikan ada shipment pending_locker untuk plat ini
    const exist = await Shipment.findOne({ courierPlate: normalizedPlate, status: "pending_locker" });
    if (!exist) {
      return res.status(401).json({
        error:
          "Tidak ada paket aktif untuk plat ini. Hubungi admin / agen jika merasa ini salah.",
      });
    }

    return res.json({
      message: "Login kurir berhasil",
      courierId: courier.courierId,
      name: courier.name,
      company: courier.company,
      plate: courier.plate,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === KURIR DEPOSIT (SCAN QR SAJA) ===
// body: { lockerToken, plate }
app.post("/api/courier/deposit", async (req, res) => {
  try {
    const { lockerToken, plate } = req.body;

    if (!lockerToken || !plate) {
      return res
        .status(400)
        .json({ error: "lockerToken dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    // cari locker berdasarkan token
    const locker = await Locker.findOne({ lockerToken: lockerToken.trim() });
    if (!locker) {
      return res.status(404).json({ error: "Locker dengan token ini tidak ditemukan" });
    }

    // cari 1 shipment yang:
    // - milik plat kurir ini
    // - masih pending_locker
    // - untuk locker ini
    const shipment = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
      lockerId: locker.lockerId,
    });

    if (!shipment) {
      return res.status(404).json({
        error:
          "Tidak ada paket pending untuk plat ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
      });
    }

    // update status shipment → delivered_to_locker
    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
    });
    await shipment.save();

    // remove resi dari pendingResi locker
    locker.pendingResi = locker.pendingResi.filter((r) => r !== shipment.resi);

    // set command open untuk ESP32
    locker.command = {
      type: "open",
      resi: shipment.resi,
      source: "courier",
      createdAt: new Date(),
    };
    await locker.save();

    return res.json({
      message: "Locker akan dibuka untuk paket ini",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      courierPlate: normalizedPlate,
    });
  } catch (err) {
    console.error("POST /api/courier/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// === ESP32 & KURIR ENDPOINTS ===

// Ambil token locker (QR) untuk ESP32
app.get("/api/locker/:lockerId/token", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await getLocker(lockerId);
    return res.json({
      lockerId,
      lockerToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("GET /api/locker/:lockerId/token error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir titip paket ke locker
app.post("/api/locker/:lockerId/deposit", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { token, resi } = req.body;

    if (!token || !resi) {
      return res.status(400).json({ error: "token dan resi wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    if (token !== locker.lockerToken) {
      return res.status(403).json({ error: "Token locker tidak valid" });
    }

    if (!locker.pendingResi.includes(resi)) {
      return res.status(403).json({
        error: "Resi tidak terdaftar untuk locker ini atau sudah diproses",
        pendingResi: locker.pendingResi,
      });
    }

    const shipment = await Shipment.findOne({ resi });
    if (!shipment) {
      return res.status(404).json({ error: "Shipment/resi tidak ditemukan" });
    }

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
    });
    await shipment.save();

    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);
    locker.command = {
      type: "open",
      resi,
      source: "courier",
      createdAt: new Date(),
    };
    await locker.save();

    return res.json({
      message: "Locker akan dibuka untuk resi ini",
      lockerId,
      resi,
      remainingPendingResi: locker.pendingResi,
    });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 polling command
app.get("/api/locker/:lockerId/command", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await getLocker(lockerId);

    if (!locker.command) {
      return res.json({ command: "none" });
    }

    const cmd = locker.command;
    locker.command = null; // one-shot
    await locker.save();

    return res.json({
      command: cmd.type,
      resi: cmd.resi,
      source: cmd.source,
      createdAt: cmd.createdAt,
    });
  } catch (err) {
    console.error("GET /api/locker/:lockerId/command error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 kirim log event
app.post("/api/locker/:lockerId/log", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { event, resi, extra } = req.body;

    const shipment = resi ? await Shipment.findOne({ resi }) : null;
    const logEntry = {
      event,
      lockerId,
      resi: resi || null,
      extra: extra || null,
      timestamp: new Date(),
    };

    if (shipment) {
      shipment.logs.push(logEntry);

      if (
        event === "locker_closed" &&
        shipment.status === "delivered_to_locker"
      ) {
        shipment.status = "ready_for_pickup";
      }

      if (event === "opened_by_customer") {
        shipment.pickedUpAt = new Date();
        shipment.status = "completed";
      }

      await shipment.save();
    }

    console.log("Locker log:", logEntry);
    return res.json({ message: "Log received", log: logEntry });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/log error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Proxy tracking umum ke Binderbyte
app.get("/api/track", async (req, res) => {
  try {
    const { courier, awb } = req.query;
    if (!courier || !awb) {
      return res
        .status(400)
        .json({ error: "courier dan awb (nomor resi) wajib diisi" });
    }

    const url = "https://api.binderbyte.com/v1/track";
    const response = await axios.get(url, {
      params: {
        api_key: BINDER_KEY,
        courier,
        awb,
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("Tracking error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: "Gagal mengambil data tracking dari Binderbyte" });
  }
});

// === DEBUG ENDPOINTS ===
app.get("/api/debug/locker/:lockerId", async (req, res) => {
  try {
    const locker = await getLocker(req.params.lockerId);
    return res.json(locker);
  } catch (err) {
    console.error("GET /api/debug/locker error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/debug/shipment/:resi", async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ resi: req.params.resi });
    if (!shipment) return res.status(404).json({ error: "Not found" });
    return res.json(shipment);
  } catch (err) {
    console.error("GET /api/debug/shipment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`Smart Locker backend running at http://localhost:${PORT}`);
});
