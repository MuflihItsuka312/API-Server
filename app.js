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

const { Schema, model } = mongoose;

// ==================================================
// MODELS
// ==================================================

/**
 * USER (customer / agent)
 * - koleksi: customer_users
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

    courierId: { type: String },
    courierPlate: { type: String },
    courierName: { type: String },

    // 🔹 token rahasia per shipment/resi (dipakai kurir + server + ESP32)
    token: { type: String, unique: true, sparse: true },

    status: { type: String, default: "assigned_to_locker" },
    createdAt: { type: Date, default: Date.now },

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
    deliveredToCustomerAt: { type: Date },
    pickedUpAt: { type: Date },
  },
  { versionKey: false }
);
const Shipment = model("Shipment", shipmentSchema, "shipments");

/**
 * Locker (per kotak fisik)
 */
const lockerSchema = new Schema(
  {
    lockerId: { type: String, required: true, unique: true },
    lockerToken: { type: String, default: null },
    
    // Lama: list resi (tetap dipertahankan untuk kompatibilitas)
    pendingResi: { type: [String], default: [] },

    // 🔹 Baru: pool resi + token per resi (dipakai skenario multi-kurir)
    pendingShipments: {
      type: [
        {
          resi: String,
          customerId: String,
          token: String,
          status: {
            type: String,
            enum: ["pending", "used"],
            default: "pending",
          },
        },
      ],
      default: [],
    },
    
    command: { type: Schema.Types.Mixed, default: null },

    // ON/OFF manual oleh agent
    isActive: { type: Boolean, default: true },

    // status heartbeat: "online" / "offline" / "unknown"
    status: { type: String, default: "unknown" },

    tokenUpdatedAt: { type: Date },
    lastHeartbeat: { type: Date },
  },
  { collection: "lockers" }
);
const Locker = model("Locker", lockerSchema);

/**
 * LockerLog (optional, audit trail)
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

/**
 * Customer manual tracking (user input resi di app)
 */
const customerTrackingSchema = new Schema(
  {
    resi: { type: String, required: true },
    courierType: { type: String, required: true },
    customerId: { type: String },
    note: { type: String },
  },
  { timestamps: true, versionKey: false }
);
const CustomerTracking = model(
  "CustomerTracking",
  customerTrackingSchema,
  "customer_trackings"
);

/**
 * Courier (kurir)
 */
const courierSchema = new Schema(
  {
    courierId: { type: String, unique: true }, // CR-ANT-xxx
    name: { type: String, required: true },
    company: { type: String, required: true }, // anteraja, jne, jnt, dll
    plate: { type: String, required: true }, // uppercased
    state: {
      type: String,
      enum: ["active", "ongoing", "inactive"],
      default: "active",
    },
  },
  {
    collection: "couriers",
    timestamps: true,
  }
);
const Courier = model("Courier", courierSchema);

// ==================================================
// HELPERS
// ==================================================

// Helper: generate random token
function randomToken(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper: generate 6-digit customerId (userId)
function generateCustomerId() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 100000 - 999999
}

// Helper: generate token unik per shipment
function generateShipmentToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "tok_";
  for (let i = 0; i < 8; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Helper: dapat locker dari Mongo, auto-create jika belum ada
async function getLocker(lockerId) {
  let locker = await Locker.findOne({ lockerId });
  if (!locker) {
    locker = await Locker.create({
      lockerId,
      lockerToken: `LK-${lockerId}-${Math.random().toString(36).slice(2, 8)}`,
      pendingResi: [],
      pendingShipments: [],        // 🔹 pastikan field baru ikut terisi
      command: null,
      isActive: true,
      status: "unknown",
    });
  }
  return locker;
}

// Helper: recalculate courier state based on shipments
async function recalcCourierState(courierId) {
  const courier = await Courier.findOne({ courierId });
  if (!courier) return;

  // cek apakah masih ada shipment aktif untuk kurir ini
  const notDoneCount = await Shipment.countDocuments({
    courierId,
    status: { $ne: "delivered_to_customer" },
  });

  let newState = courier.state;

  if (notDoneCount > 0) {
    // masih ada tugas
    newState = "ongoing";
  } else {
    // semua tugas selesai -> INACTIVE
    newState = "inactive";
  }

  if (newState !== courier.state) {
    courier.state = newState;
    await courier.save();
    console.log(`[COURIER] ${courierId} -> ${newState}`);
  }
}

// Auth middleware (JWT)
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

// ==================================================
// ROUTES
// ==================================================

// 0. Health check
app.get("/", (req, res) => {
  res.send("Smart Locker backend with MongoDB is running ✅");
});

// ---------------------- AUTH (Customer) ----------------------

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
      userId: generateCustomerId(), // 6 digit random
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

// ---------------------- AGENT: Shipments ----------------------

// Agent input paket (bisa banyak resi sekaligus)
app.post("/api/shipments", async (req, res) => {
  try {
    const {
      lockerId,
      courierType,
      resiList,
      receiverName,
      receiverPhone,
      customerId,
      itemType,
      courierPlate,
      courierLabel,
      courierId,
    } = req.body;

    if (!lockerId || !courierType || !Array.isArray(resiList) || resiList.length === 0) {
      return res
        .status(400)
        .json({ error: "lockerId, courierType, resiList wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    // coba ambil nama kurir dari koleksi Courier jika courierId dikirim
    let courierName = courierLabel || "";
    let courier = null;
    if (courierId) {
      courier = await Courier.findOne({ courierId });
      if (!courier) {
        return res.status(404).json({ error: "Courier not found" });
      }
      if (courier.state !== "active") {
        return res
          .status(400)
          .json({ error: `Courier ${courierId} not available (state=${courier.state})` });
      }
      courierName = courier.name;
    }

    const createdShipments = [];

    for (const resi of resiList) {
      const normalizedResi = String(resi).trim();

      // Cek shipment existing
      let sh = await Shipment.findOne({ resi: normalizedResi });

      if (sh) {
        // Kalau shipment lama BELUM ada token, generate sekarang
        if (!sh.token) {
          sh.token = generateShipmentToken();
          await sh.save();
        }

        // Masukkan ke pendingResi (lama) kalau belum ada
        if (
          !locker.pendingResi.includes(normalizedResi) &&
          sh.status !== "completed" &&
          sh.status !== "delivered_to_locker"
        ) {
          locker.pendingResi.push(normalizedResi);
        }

        // Masukkan ke pendingShipments (baru) kalau belum ada
        const alreadyInPool = locker.pendingShipments.some(
          (p) => p.resi === normalizedResi && p.token === sh.token
        );
        if (!alreadyInPool) {
          locker.pendingShipments.push({
            resi: normalizedResi,
            customerId: sh.customerId || customerId || "",
            token: sh.token,
            status: "pending",
          });
        }

        createdShipments.push(sh);
        continue;
      }

      // Shipment BARU
      const shipmentToken = generateShipmentToken();

      sh = await Shipment.create({
        resi: normalizedResi,
        courierType,
        lockerId,
        courierId: courierId || "",
        receiverName: receiverName || "Customer Demo",
        receiverPhone: receiverPhone || "",
        customerId: customerId || "",
        itemType: itemType || "",
        courierPlate: courierPlate
          ? courierPlate.trim().toUpperCase()
          : courier
          ? courier.plate
          : "",
        courierName: courierName || "",
        token: shipmentToken,             // 🔹 token per resi
        status: "pending_locker",
        createdAt: new Date(),
        logs: [
          {
            event: "assigned_to_locker",
            lockerId,
            resi: normalizedResi,
            timestamp: new Date(),
            extra: { source: "agent" },
          },
        ],
      });

      createdShipments.push(sh);

      if (!locker.pendingResi.includes(normalizedResi)) {
        locker.pendingResi.push(normalizedResi);
      }

      locker.pendingShipments.push({
        resi: normalizedResi,
        customerId: sh.customerId || customerId || "",
        token: shipmentToken,
        status: "pending",
      });
    }

    await locker.save();

    // Set courier to ONGOING after assignment
    if (courier) {
      courier.state = "ongoing";
      await courier.save();
      console.log(`[COURIER] ${courierId} -> ongoing (assigned shipments)`);
    }

    return res.json({
      message: "Shipments assigned to locker",
      locker,
      shipments: createdShipments,
    });
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

// SANITASI: hapus shipment
app.delete("/api/shipments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Shipment.findByIdAndDelete(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/shipments/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
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

// ---------------------- CUSTOMER ENDPOINTS ----------------------

// Customer input resi manual (disimpan supaya agen bisa lihat)
// Customer input resi manual (dengan auto-validasi Binderbyte)
app.post("/api/customer/manual-resi", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { resi } = req.body;

    if (!resi) {
      return res.status(400).json({ error: "Nomor resi wajib diisi" });
    }

    const normalizedResi = resi.trim();

    // VALIDASI OTOMATIS KE BINDERBYTE
    if (! BINDER_KEY) {
      return res.status(500).json({
        error: "API Binderbyte belum dikonfigurasi di server",
      });
    }

    console.log(`[VALIDASI RESI] Validating ${normalizedResi}...`);

    // Coba deteksi courier dari berbagai ekspedisi
    const couriers = ["jne", "jnt", "anteraja", "sicepat", "ninja", "pos"];
    let validCourier = null;
    let validData = null;

    for (const courier of couriers) {
      try {
        const bbResp = await axios.get("https://api.binderbyte.com/v1/track", {
          params: {
            api_key: BINDER_KEY,
            courier: courier,
            awb: normalizedResi,
          },
        });

        // Cek apakah response valid
        if (
          bbResp.data &&
          bbResp.data. status === 200 &&
          bbResp. data.data &&
          bbResp.data.data.summary
        ) {
          validCourier = courier;
          validData = bbResp.data;
          console.log(`[VALIDASI RESI] ✅ Valid di ${courier. toUpperCase()}`);
          break;
        }
      } catch (err) {
        // Lanjut coba courier berikutnya
        continue;
      }
    }

    // Jika tidak valid di semua courier
    if (!validCourier) {
      return res.status(400).json({
        error:
          "Nomor resi tidak valid atau tidak ditemukan di sistem ekspedisi manapun",
      });
    }

    // Simpan ke database jika valid
    const doc = await CustomerTracking.create({
      resi: normalizedResi,
      courierType: validCourier,
      customerId: userId,
      note: `Auto-validated via ${validCourier. toUpperCase()}`,
    });

    res.json({
      message: `Resi berhasil disimpan!  Terdeteksi sebagai paket ${validCourier.toUpperCase()}`,
      data: {
        resi: doc.resi,
        courier: validCourier,
        customerId: userId,
        trackingInfo: validData. data.summary,
      },
    });
  } catch (err) {
    console.error("POST /api/customer/manual-resi error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// Agent melihat semua resi manual dari user
app.get("/api/manual-resi", async (req, res) => {
  try {
    const list = await CustomerTracking.find({})
      .sort({ createdAt: -1 })
      .lean();
    res.json({ data: list });
  } catch (err) {
    console.error("GET /api/manual-resi error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// List semua shipment milik customer (pakai JWT)
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

// Customer minta buka locker untuk resi tertentu
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
      {
        command: {
          type: "open",
          resi,
          source: "customer",
          createdAt: new Date(),
        },
      },
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

// Detail tracking 1 resi (Binderbyte + internal)
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

// ---------------------- COURIER ENDPOINTS ----------------------

// GET semua kurir
app.get("/api/couriers", async (req, res) => {
  try {
    const couriers = await Courier.find({})
      .sort({ company: 1, name: 1 })
      .lean();
    res.json({ ok: true, data: couriers });
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
      state: "active",
    });

    res.json({ ok: true, message: "Kurir berhasil ditambahkan", data: courier });
  } catch (err) {
    console.error("POST /api/couriers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update status kurir (active / ongoing / inactive)
app.put("/api/couriers/:courierId/status", async (req, res) => {
  try {
    const { courierId } = req.params;
    const { state } = req.body;

    if (!state || !["active", "ongoing", "inactive"].includes(state)) {
      return res.status(400).json({ error: "Invalid state. Must be: active, ongoing, or inactive" });
    }

    const courier = await Courier.findOneAndUpdate(
      { courierId },
      { state },
      { new: true }
    );

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    res.json({ ok: true, message: "Status kurir diupdate", data: courier });
  } catch (err) {
    console.error("PUT /api/couriers/:courierId/status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// SANITASI: hapus kurir
app.delete("/api/couriers/:courierId", async (req, res) => {
  try {
    await Courier.deleteOne({ courierId: req.params.courierId });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/couriers/:courierId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir login
app.post("/api/courier/login", async (req, res) => {
  try {
    const { name, plate } = req.body;
    if (!name || !plate) {
      return res.status(400).json({ error: "name dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    const courier = await Courier.findOne({
      plate: normalizedPlate,
    });
    if (!courier) {
      return res
        .status(401)
        .json({ error: "Kurir tidak terdaftar." });
    }
    
    if (courier.state === "inactive") {
      return res
        .status(401)
        .json({ error: "Kurir sudah tidak aktif. Hubungi admin untuk aktivasi kembali." });
    }

    if (courier.name.toLowerCase() !== name.trim().toLowerCase()) {
      return res.status(401).json({ error: "Nama kurir tidak sesuai" });
    }

    const exist = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
    });
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
    console.error("POST /api/courier/login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir deposit via scan QR token + plat
app.post("/api/courier/deposit", async (req, res) => {
  try {
    const { lockerToken, plate } = req.body;

    if (!lockerToken || !plate) {
      return res
        .status(400)
        .json({ error: "lockerToken dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    const locker = await Locker.findOne({ lockerToken: lockerToken.trim() });
    if (!locker) {
      return res
        .status(404)
        .json({ error: "Locker dengan token ini tidak ditemukan" });
    }

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

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
    });
    await shipment.save();

    locker.pendingResi = locker.pendingResi.filter((r) => r !== shipment.resi);
    locker.command = {
      type: "open",
      resi: shipment.resi,
      source: "courier",
      createdAt: new Date(),
    };
    await locker.save();

    // Recalc courier state after delivery (stays ongoing until all delivered to customer)
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

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

// 🔹 Kurir: ambil daftar shipment + token (versi baru)
app.get("/api/courier/tasks-token", async (req, res) => {
  try {
    const { plate, courierId } = req.query;

    const filter = {
      status: "pending_locker", // shipment yang belum masuk locker
    };

    if (plate) {
      filter.courierPlate = plate.trim().toUpperCase();
    }
    if (courierId) {
      filter.courierId = courierId;
    }

    const shipments = await Shipment.find(filter).lean();

    return res.json({
      ok: true,
      data: shipments.map((s) => ({
        shipmentId: s._id,
        resi: s.resi,
        lockerId: s.lockerId,
        courierType: s.courierType,
        courierPlate: s.courierPlate,
        customerId: s.customerId,
        token: s.token, // 🔹 ini yang nanti dipakai di deposit-token
        status: s.status,
      })),
    });
  } catch (err) {
    console.error("GET /api/courier/tasks-token error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// 🔹 Kurir deposit paket pakai shipmentToken + lockerToken (mode baru)
app.post("/api/courier/deposit-token", async (req, res) => {
  try {
    const { lockerId, lockerToken, shipmentToken, resi } = req.body;

    if (!lockerId || !lockerToken || !shipmentToken || !resi) {
      return res.status(400).json({
        error: "lockerId, lockerToken, shipmentToken, dan resi wajib diisi",
      });
    }

    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker tidak ditemukan" });
    }

    // Validasi lockerToken (QR dari ESP32)
    if (!locker.lockerToken || locker.lockerToken !== lockerToken.trim()) {
      return res
        .status(400)
        .json({ error: "Locker token tidak valid / kadaluarsa" });
    }

    // Cari pending shipment di pool baru
    const idx = locker.pendingShipments.findIndex(
      (p) =>
        p.resi === resi &&
        p.token === shipmentToken &&
        p.status === "pending"
    );

    if (idx === -1) {
      return res.status(400).json({
        error:
          "Token atau resi tidak cocok dengan shipment pending di locker ini",
      });
    }

    const pending = locker.pendingShipments[idx];

    // Update pendingShipments -> used
    locker.pendingShipments[idx].status = "used";

    // Update shipment utama
    const shipment = await Shipment.findOne({
      resi,
      token: shipmentToken,
      lockerId,
    });

    if (!shipment) {
      return res
        .status(404)
        .json({ error: "Shipment utama tidak ditemukan" });
    }

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_token" },
    });
    await shipment.save();

    // command untuk ESP32
    locker.command = {
      type: "open",
      resi,
      source: "courier_token",
      createdAt: new Date(),
      customerId: pending.customerId,
    };

    // still keep pendingResi lama sebagai fallback
    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);

    await locker.save();

    // Optional: recalc courier state
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    return res.json({
      ok: true,
      message: "Deposit berhasil, locker akan dibuka",
      data: {
        lockerId,
        resi,
        customerId: pending.customerId,
      },
    });
  } catch (err) {
    console.error("POST /api/courier/deposit-token error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Mark shipment as delivered to customer (called when package is picked up)
app.post("/api/shipments/:resi/delivered-customer", async (req, res) => {
  try {
    const { resi } = req.params;

    const shipment = await Shipment.findOneAndUpdate(
      { resi },
      {
        status: "delivered_to_customer",
        deliveredToCustomerAt: new Date(),
      },
      { new: true }
    );

    if (!shipment) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    // hapus resi dari pendingResi locker
    await Locker.updateOne(
      { lockerId: shipment.lockerId },
      { $pull: { pendingResi: resi } }
    );

    // Recalculate state kurir yang mengantar shipment ini
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    res.json({ ok: true, data: shipment });
  } catch (err) {
    console.error("POST /api/shipments/:resi/delivered-customer error:", err);
    res.status(500).json({ error: "Failed to mark delivered" });
  }
});

// Kurir scan locker (QR code scan validation)
app.post("/api/scan", async (req, res) => {
  try {
    const { courierId, lockerId, token, resi } = req.body;

    if (!courierId || !lockerId || !token) {
      return res.status(400).json({ error: "courierId, lockerId, dan token wajib diisi" });
    }

    const courier = await Courier.findOne({ courierId });
    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    if (courier.state === "inactive") {
      return res.status(403).json({ error: "Courier is inactive, cannot scan" });
    }

    // Validate locker token
    const locker = await Locker.findOne({ lockerId, lockerToken: token });
    if (!locker) {
      return res.status(404).json({ error: "Invalid locker or token" });
    }

    // If resi provided, validate it belongs to this courier and locker
    if (resi) {
      const shipment = await Shipment.findOne({
        resi,
        courierId,
        lockerId,
        status: "pending_locker",
      });

      if (!shipment) {
        return res.status(404).json({
          error: "Resi tidak ditemukan atau tidak sesuai dengan kurir dan locker ini",
        });
      }
    }

    res.json({
      ok: true,
      message: "Scan berhasil",
      lockerId,
      courierId,
    });
  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500).json({ error: "Scan failed" });
  }
});

// ---------------------- LOCKER LIST / POOL ----------------------

// GET semua locker (untuk Agent Locker Client Pool)

app.get("/api/lockers", async (req, res) => {
  try {
    const lockers = await Locker.find();
    console.log(`[DEBUG] GET /api/lockers - Found ${lockers.length} lockers`);
    lockers.forEach(locker => {
      console.log(`[DEBUG] Locker ${locker.lockerId}: lastHeartbeat=${locker.lastHeartbeat}, status=${locker.status}`);
    });
    // Status calculation logic
    const now = new Date();
    const updatedLockers = lockers.map(locker => {
      let status = "unknown";
      if (locker.lastHeartbeat) {
        const diff = now - new Date(locker.lastHeartbeat);
        // 2 minutes threshold for online
        if (diff < 2 * 60 * 1000) {
          status = "online";
        } else {
          status = "offline";
        }
      }
      return {
        ...locker.toObject(),
        status,
      };
    });
    return res.json(updatedLockers);
  } catch (err) {
    console.error("GET /api/lockers error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// GET detail locker
app.get("/api/lockers/:lockerId", async (req, res) => {
  try {
    const locker = await Locker.findOne({
      lockerId: req.params.lockerId,
    }).lean();

    if (!locker) return res.status(404).json({ error: "Locker not found" });

    res.json({ data: locker });
  } catch (err) {
    console.error("GET /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// SANITASI: hapus locker
app.delete("/api/lockers/:lockerId", async (req, res) => {
  try {
    await Locker.deleteOne({ lockerId: req.params.lockerId });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// ---------------------- ESP32 & Locker Command ----------------------

// Ambil token locker (QR) untuk ESP32 + HEARTBEAT
// 1) Heartbeat + get token (dipanggil ESP32)
app.get("/api/locker/:lockerId/token", async (req, res) => {
  const { lockerId } = req.params;

  try {
    let locker = await Locker.findOne({ lockerId });

    if (!locker) {
      locker = await Locker.create({
        lockerId,
        lockerToken: randomToken("LK-" + lockerId),
        isActive: true,
        status: "offline",
      });
    }

    const now = new Date();

    // update heartbeat + status
    locker.lastHeartbeat = now;
    locker.status = "online";
    await locker.save();

    res.json({
      lockerId: locker.lockerId,
      lockerToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("get locker token error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Kurir titip paket ke locker (mode lama: token + resi manual)
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

// 1) Heartbeat + get token (dipanggil ESP32)
app.get("/api/locker/:lockerId/token", async (req, res) => {
  const { lockerId } = req.params;

  try {
    let locker = await Locker.findOne({ lockerId });

    if (!locker) {
      locker = await Locker.create({
        lockerId,
        lockerToken: randomToken("LK-" + lockerId),
        isActive: true,
        status: "offline",
      });
    }

    const now = new Date();

    // update heartbeat + status
    locker.lastHeartbeat = now;
    locker.status = "online";
    await locker.save();

    res.json({
      lockerId: locker.lockerId,
      lockerToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("get locker token error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// ESP32 polling command (open, dsb.)
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

// ESP32 heartbeat - dipanggil berkala oleh ESP32
app.post("/api/locker/:lockerId/heartbeat", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }
    locker.status = "online";
    locker.lastHeartbeat = new Date();
    await locker.save();
    console.log(`[HEARTBEAT] Locker ${lockerId} at ${locker.lastHeartbeat}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/heartbeat error:", err);
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

// ---------------------- Binderbyte Proxy ----------------------

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

// ---------------------- DEBUG ----------------------

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

// ==================================================
// START SERVER
// ==================================================
app.listen(PORT, () => {
  console.log(`Smart Locker backend running at http://localhost:${PORT}`);
});
