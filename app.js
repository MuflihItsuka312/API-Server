// server.js - Smart Locker Backend + Mongoose + Auth Customer
// Implements One-Time Token System for Locker Access

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const promBundle = require('express-prom-bundle');
const promClient = require('prom-client');
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// ==================================================
// CUSTOM PROMETHEUS METRICS FOR THESIS
// ==================================================
// Note: express-prom-bundle already provides http_request_duration_seconds
// We'll use a separate registry for our custom business metrics

const customRegister = new promClient.Registry();

// Database Query Duration
const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'collection'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [customRegister],
});

// External API Call Duration (Binderbyte)
const externalApiDuration = new promClient.Histogram({
  name: 'external_api_duration_seconds',
  help: 'Duration of external API calls in seconds',
  labelNames: ['api', 'endpoint', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [customRegister],
});

// Locker Operations Counter
const lockerOperations = new promClient.Counter({
  name: 'locker_operations_total',
  help: 'Total number of locker operations',
  labelNames: ['operation', 'locker_id', 'status'],
  registers: [customRegister],
});

// QR Code Scans Counter
const qrScans = new promClient.Counter({
  name: 'qr_scans_total',
  help: 'Total number of QR code scans',
  labelNames: ['user_type', 'status'],
  registers: [customRegister],
});

// Shipment Status Counter
const shipmentStatus = new promClient.Counter({
  name: 'shipments_status_total',
  help: 'Total shipments by status',
  labelNames: ['status'],
  registers: [customRegister],
});

// Add default metrics (CPU, memory, etc.) to custom registry
promClient.collectDefaultMetrics({ register: customRegister });

// ==================================================
// PROMETHEUS METRICS MIDDLEWARE
// ==================================================
// express-prom-bundle creates its own registry and /metrics endpoint
// We'll merge our custom metrics into it
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  promClient: {
    collectDefaultMetrics: {}
  },
  metricsPath: '/metrics',
  normalizePath: [
    ['^/api/locker/[0-9a-fA-F-]+', '/api/locker/#id'],
    ['^/api/customer/resi/[^/]+', '/api/customer/resi/#resi'],
    ['^/api/manual-resi/revalidate/[^/]+', '/api/manual-resi/revalidate/#resi'],
  ],
  // Add our custom metrics to the bundle's metrics endpoint
  customLabels: {},
  transformLabels: () => ({}),
  autoregister: true,
});

app.use(metricsMiddleware);

app.use(cors());
app.use(express.json());

// Override /metrics endpoint AFTER middleware to merge all metrics
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', promClient.register.contentType);
    const bundledMetrics = await promClient.register.metrics();
    const customMetrics = await customRegister.metrics();
    res.end(bundledMetrics + customMetrics);
  } catch (error) {
    console.error('Error generating metrics:', error);
    res.status(500).end('Error generating metrics');
  }
});

// ==================================================
// ENHANCED METRICS MIDDLEWARE (for thesis analytics)
// Note: express-prom-bundle already tracks request duration
// This middleware only adds console logging
// ==================================================
app.use((req, res, next) => {
  const startTime = Date.now();
  const startDate = new Date().toISOString();
  
  // Log when request is received
  console.log(`[API IN] ${req.method} ${req.path} - Received at ${startDate}`);
  
  // Override res.json to capture response time
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // Convert to seconds
    const endDate = new Date().toISOString();
    
    console.log(`[API OUT] ${req.method} ${req.path} - Status ${res.statusCode} - Duration: ${(duration * 1000).toFixed(2)}ms - Sent at ${endDate}`);
    
    return originalJson(data);
  };
  
  // Also capture non-JSON responses
  const originalSend = res.send.bind(res);
  res.send = function(data) {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const endDate = new Date().toISOString();
    
    console.log(`[API OUT] ${req.method} ${req.path} - Status ${res.statusCode} - Duration: ${(duration * 1000).toFixed(2)}ms - Sent at ${endDate}`);
    
    return originalSend(data);
  };
  
  next();
});

// Configure axios defaults for better timeout handling
axios.defaults.timeout = 30000; // 30 seconds default
axios.defaults.headers.common['User-Agent'] = 'Smart-Locker-Backend/1.0';

// === ENV ===
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/smartlocker";
const BINDER_KEY = process.env. BINDERBYTE_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "supersecret-key-for-dev";

// === KONEKSI MONGODB ===
mongoose
  .connect(MONGO_URI)
  .then(() => console. log("✅ Connected to MongoDB"))
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
    address: String, // Added for agent profile
    passwordHash: String,
    role: { type: String, default: "customer" }, // customer / agent / admin
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
const User = model("User", userSchema, "customer_users");

/**
 * Shipment (paket per resi)
 * OPTIMIZED: Removed per-resi token - using only lockerToken for access
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

    // Weight tracking (in kilograms)
    weight: { type: Number, default: null }, // Weight in kilograms from load cell sensor
    weightRecordedAt: { type: Date, default: null }, // When weight was measured

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
 * Updated with courierHistory for one-time token tracking
 * OPTIMIZED: Removed pendingShipments token pool - using simpler pendingResi
 */
const lockerSchema = new Schema(
  {
    lockerId: { type: String, required: true, unique: true },
    lockerToken: { type: String, default: null },

    // Link to customer account
    customerId: { type: String, default: null }, // userId from User collection

    // Owner Information (from registration form)
    ownerName: { type: String, default: null },
    ownerAddress: { type: String, default: null },
    ownerPhone: { type: String, default: null },

    // Track all couriers who delivered here
    courierHistory: {
      type: [
        {
          courierId: String,
          courierName: String,
          courierPlate: String,
          resi: String,
          deliveredAt: Date,
          usedToken: String,
        },
      ],
      default: [],
    },

    // 🔍 DEBUG info untuk pengujian waktu respon
    debugInfo: {
      type: {
        enabled: { type: Boolean, default: false },
        resi: String,
        scanAtClient: Date,   // waktu di app kurir (opsional)
        scanAtBackend: Date,  // waktu request masuk backend
        commandSentAt: Date,  // waktu ESP ambil command
        espLogAt: Date,       // waktu ESP kirim log "locker_opened"
        lastEvent: String,
      },
      default: null,
    },

    // List of pending resi numbers for this locker
    pendingResi: { type: [String], default: [] },

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
    at: { type: Date, default: Date. now },
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
    courierType: { type: String },
    customerId: { type: String },
    note: { type: String },
    validated: { type: Boolean, default: false },
    validationAttempted: { type: Boolean, default: false },
    binderbyteData: {
      summary: { type: Object },
      validatedAt: { type: Date }
    },
    // 🔥 NEW: Smart locker assignment
    assignedLockerId: { type: String },
    lockerAssignedAt: { type: Date },
    // JNE specific: 5-digit customer number required for tracking
    jneNumber: { type: String },
    // Weight tracking (from customer input or ESP32)
    weight: { type: Number, default: null }, // Weight in kilograms
    weightRecordedAt: { type: Date, default: null }, // When weight was recorded
    weightSource: { type: String, enum: ['customer', 'esp32', 'courier'], default: null }, // Who provided weight
  },
  {
    collection: "customer_trackings",
    timestamps: true,
  }
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
    phone: { type: String }, // ✅ Added for courier registration
    passwordHash: { type: String }, // ✅ Added for courier authentication
    state: {
      type: String,
      enum: ["active", "ongoing", "inactive"],
      default: "active", // ✅ Default is active now (instant activation)
    },
    lastActiveAt: { type: Date, default: Date.now }, // ✅ Track last activity
    inactiveSince: { type: Date }, // ✅ When courier became inactive
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

// Helper: generate cryptographically secure random token
function randomToken(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

// Helper: generate 6-digit customerId (userId)
function generateCustomerId() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 100000 - 999999
}

// Helper: dapat locker dari Mongo, auto-create jika belum ada
async function getLocker(lockerId) {
  let locker = await Locker. findOne({ lockerId });
  if (!locker) {
    locker = await Locker. create({
      lockerId,
      lockerToken: randomToken(`LK-${lockerId}`),
      pendingResi: [],
      courierHistory: [],
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

  // Check if courier has pending deliveries
  const pendingCount = await Shipment.countDocuments({
    courierId,
    status: "pending_locker", // Not yet delivered to locker
  });

  let newState = courier.state;

  if (pendingCount > 0) {
    // Has pending deliveries -> ONGOING
    newState = "ongoing";
    courier.lastActiveAt = new Date(); // Update last activity
  } else {
    // No pending deliveries -> ACTIVE (not inactive!)
    newState = "active"; // ✅ Changed from "inactive" to "active"
    courier.lastActiveAt = new Date(); // Update last activity
  }

  if (newState !== courier.state) {
    courier.state = newState;
    await courier.save();
    console.log(`[COURIER] ${courierId} -> ${newState}`);
  } else {
    // Just update lastActiveAt even if state didn't change
    courier.lastActiveAt = new Date();
    await courier.save();
  }
}

// Helper: update courier activity timestamp
async function updateCourierActivity(courierId) {
  if (!courierId) return;

  const courier = await Courier.findOne({ courierId });
  if (courier) {
    courier.lastActiveAt = new Date();
    await courier.save();
    console.log(`[COURIER ACTIVITY] ${courierId} last active updated`);
  }
}

// Helper: send notification to customer (placeholder - implement with FCM/push service)
async function sendNotificationToCustomer(userId, title, message, data = {}) {
  // TODO: Implement with Firebase Cloud Messaging or other push notification service
  console.log(`[NOTIFICATION] To customer ${userId}: ${title} - ${message}`, data);
  // For now, just log. In production, send via FCM/OneSignal/etc.
  return Promise.resolve();
}

// 🔍 Helper: Log debug phases for QR scan timing analysis (thesis)
function pushDebugPhase(locker, phase, extra = {}) {
  if (!locker) return;
  if (!locker.debugInfo) locker.debugInfo = { enabled: false };

  const now = new Date();

  if (phase === "scan") {
    locker.debugInfo.enabled = true;
    locker.debugInfo.scanAtBackend = now;
  } else if (phase === "command") {
    locker.debugInfo.commandSentAt = now;
  } else if (phase === "esp_log") {
    locker.debugInfo.espLogAt = now;
  }

  locker.debugInfo.lastEvent = phase;
  Object.assign(locker.debugInfo, extra);

  console.log(
    `[DEBUG-QR] phase=${phase} locker=${locker.lockerId} resi=${locker.debugInfo.resi || "-"} info=`,
    locker.debugInfo
  );
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

// Courier Auth Middleware (JWT for couriers)
function authCourier(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: "Token missing" });

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.courierId) {
      return res.status(401).json({ error: "Invalid courier token" });
    }

    req.courier = decoded; // { courierId, plate, company }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ==================================================
// RESI VALIDATION HELPERS
// ==================================================

/**
 * Sanitize resi number - remove spaces, special chars, convert to uppercase
 */
function sanitizeResi(resi) {
  if (!resi || typeof resi !== 'string') return null;

  // Remove all whitespace and convert to uppercase
  const cleaned = resi.trim().replace(/\s+/g, '').toUpperCase();

  // Must be at least 8 characters and alphanumeric
  if (cleaned.length < 8 || !/^[A-Z0-9]+$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Detect courier type from resi format (for smart priority ordering)
 * Note: This is for PRIORITIZATION ONLY, not rejection.
 * Unknown formats will still be validated via Binderbyte API.
 */
function detectCourierType(resi) {
  if (!resi || resi.length < 8) {
    return { detected: false, courierType: null };
  }

  // JNE: starts with JNE or CGK, 10-15 alphanumeric chars
  if (/^(JNE|CGK)[A-Z0-9]{7,12}$/i.test(resi)) {
    return { detected: true, courierType: 'jne' };
  }

  // J&T: starts with JT or JX, followed by digits
  if (/^(JT|JX)\d{10,14}$/i.test(resi)) {
    return { detected: true, courierType: 'jnt' };
  }

  // AnterAja: starts with TSA or 10-15 alphanumeric
  if (/^TSA[A-Z0-9]{7,12}$/i.test(resi) || (/^[A-Z0-9]{10,15}$/i.test(resi) && resi.length >= 10)) {
    return { detected: true, courierType: 'anteraja' };
  }

  // SiCepat: exactly 12 digits
  if (/^\d{12}$/i.test(resi)) {
    return { detected: true, courierType: 'sicepat' };
  }

  // Ninja Express: starts with NLIDAP or NV, followed by digits
  if (/^(NLIDAP|NV)\d{8,12}$/i.test(resi)) {
    return { detected: true, courierType: 'ninja' };
  }

  // POS Indonesia: RR...ID format or 13 digits
  if (/^RR\d{9}ID$/i.test(resi) || /^\d{13}$/i.test(resi)) {
    return { detected: true, courierType: 'pos' };
  }

  // Unknown format - will try all couriers
  return { detected: false, courierType: null };
}

// ==================================================
// AUTO-CLEANUP INACTIVE COURIERS
// ==================================================

// Mark couriers as inactive if no activity for 7 days
async function checkInactiveCouriers() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Find active/ongoing couriers who haven't been active in 7 days
    const inactiveCouriers = await Courier.find({
      state: { $in: ["active", "ongoing"] },
      lastActiveAt: { $lt: sevenDaysAgo },
    });

    for (const courier of inactiveCouriers) {
      courier.state = "inactive";
      courier.inactiveSince = new Date();
      await courier.save();
      console.log(`[AUTO-CLEANUP] ${courier.courierId} marked as INACTIVE (no activity for 7 days)`);
    }

    if (inactiveCouriers.length > 0) {
      console.log(`[AUTO-CLEANUP] ${inactiveCouriers.length} couriers marked as inactive`);
    }
  } catch (err) {
    console.error("[AUTO-CLEANUP] Error checking inactive couriers:", err);
  }
}

// Delete couriers who have been inactive for 7+ days
async function deleteOldInactiveCouriers() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Find inactive couriers who have been inactive for 7+ days
    const deleteCandidates = await Courier.find({
      state: "inactive",
      inactiveSince: { $lt: sevenDaysAgo },
    });

    for (const courier of deleteCandidates) {
      // Check if they have any completed deliveries
      const deliveryCount = await Shipment.countDocuments({
        courierId: courier.courierId,
      });

      if (deliveryCount === 0) {
        // No deliveries ever made, safe to delete
        await Courier.deleteOne({ courierId: courier.courierId });
        console.log(`[AUTO-CLEANUP] DELETED ${courier.courierId} (inactive for 7+ days, no deliveries)`);
      } else {
        // Has delivery history, keep for records but mark
        console.log(`[AUTO-CLEANUP] Keeping ${courier.courierId} (has ${deliveryCount} delivery records)`);
      }
    }

    if (deleteCandidates.length > 0) {
      console.log(`[AUTO-CLEANUP] Processed ${deleteCandidates.length} inactive couriers`);
    }
  } catch (err) {
    console.error("[AUTO-CLEANUP] Error deleting inactive couriers:", err);
  }
}

// Run cleanup every hour
setInterval(() => {
  checkInactiveCouriers();
  deleteOldInactiveCouriers();
}, 60 * 60 * 1000); // 1 hour

// Run immediately on startup
setTimeout(() => {
  console.log("[AUTO-CLEANUP] Running initial cleanup check...");
  checkInactiveCouriers();
  deleteOldInactiveCouriers();
}, 5000); // 5 seconds after startup

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
    const { name, email, phone, address, password } = req.body;

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
      address, // ✅ Now saving address
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

    if (! lockerId || !courierType || !Array.isArray(resiList) || resiList.length === 0) {
      return res
        .status(400)
        .json({ error: "lockerId, courierType, resiList wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    // coba ambil nama kurir dari koleksi Courier jika courierId dikirim
    let courierName = courierLabel || "";
    let courier = null;
    if (courierId) {
      courier = await Courier. findOne({ courierId });
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
        // Masukkan ke pendingResi kalau belum ada
        if (
          !locker.pendingResi.includes(normalizedResi) &&
          sh.status !== "completed" &&
          sh.status !== "delivered_to_locker"
        ) {
          locker.pendingResi. push(normalizedResi);
        }

        createdShipments.push(sh);
        continue;
      }

      // Shipment BARU - simplified without per-resi token
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
          ? courierPlate.trim(). toUpperCase()
          : courier
          ? courier.plate
          : "",
        courierName: courierName || "",
        weight: null, // Will be set when courier deposits package (in kg)
        weightRecordedAt: null,
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

      if (! locker.pendingResi. includes(normalizedResi)) {
        locker.pendingResi.push(normalizedResi);
      }
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
    return res. status(500).json({ error: "Internal server error" });
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
    console. error("GET /api/shipments error:", err);
    res. status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// SANITASI: hapus shipment
app.delete("/api/shipments/:id", async (req, res) => {
  try {
    const { id } = req. params;
    await Shipment.findByIdAndDelete(id);
    res. json({ ok: true });
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

    if (! BINDER_KEY) {
      return res. status(500).json({
        valid: false,
        error: "BINDERBYTE_API_KEY belum dikonfigurasi",
      });
    }

    const url = "https://api.binderbyte. com/v1/track";
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
    console. error("validate-resi error:", err. response?.data || err.message);

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

// ==================== CUSTOMER: Input Resi Manual (CACHED VALIDATION) ====================
app.post("/api/customer/manual-resi", auth, async (req, res) => {
  try {
    const { resi, jneNumber } = req.body;
    const userId = req.user.userId;

    if (!resi || !resi.trim()) {
      return res.status(400).json({ error: "Nomor resi wajib diisi" });
    }

    const cleanResi = resi.trim().toUpperCase();
    console.log(`[RESI INPUT] Customer ${userId}: "${cleanResi}"${jneNumber ? ` + JNE#${jneNumber}` : ''}`);

    // ✅ STEP 1: CHECK IF THIS USER ALREADY HAS THIS RESI
    const existing = await CustomerTracking.findOne({
      resi: cleanResi,
      customerId: userId
    });

    if (existing) {
      return res.status(400).json({
        error: "Resi ini sudah pernah Anda input sebelumnya",
        resi: cleanResi,
        inputDate: existing.createdAt
      });
    }

    // ✅ STEP 2: CHECK GLOBAL CACHE (any customer validated this resi before)
    const cachedResi = await CustomerTracking.findOne({
      resi: cleanResi,
      validated: true
    }).lean();

    if (cachedResi) {
      console.log(`[RESI CACHE HIT] ${cleanResi} found in cache as ${cachedResi.courierType.toUpperCase()}`);
      
      // Create entry for this user using cached data
      const tracking = await CustomerTracking.create({
        resi: cleanResi,
        courierType: cachedResi.courierType,
        customerId: userId,
        note: `✅ Validated from cache (${cachedResi.courierType.toUpperCase()})`,
        validated: true,
        validationAttempted: true,
        binderbyteData: cachedResi.binderbyteData || null
      });

      // 🔥 Auto-assign locker for cached resi too (only customer's own lockers)
      let assignedLockerId = null;
      try {
        const availableLocker = await Locker.findOne({
          customerId: userId, // Only customer's own lockers
          status: 'online',
          isActive: true
        }).sort({ 'pendingResi.length': 1 }); // Least busy locker first

        if (availableLocker) {
          assignedLockerId = availableLocker.lockerId;
          tracking.assignedLockerId = assignedLockerId;
          tracking.lockerAssignedAt = new Date();
          await tracking.save();
          console.log(`[LOCKER ASSIGNED] ${assignedLockerId} auto-assigned to cached ${cleanResi} (customer: ${userId})`);
        } else {
          console.log(`[LOCKER ASSIGN] No online locker available for customer ${userId}`);
        }
      } catch (assignErr) {
        console.error('[LOCKER ASSIGN] Failed:', assignErr.message);
      }

      console.log(`[RESI SAVED] ✅ ${cleanResi} for customer ${userId} via CACHE (${cachedResi.courierType.toUpperCase()})`);

      return res.json({
        ok: true,
        message: `Resi berhasil ditambahkan (${cachedResi.courierType.toUpperCase()})`,
        fromCache: true,
        data: {
          resi: cleanResi,
          courierType: cachedResi.courierType,
          validated: true,
          assignedLockerId: assignedLockerId,
          tracking: cachedResi.binderbyteData || null,
          createdAt: tracking.createdAt
        }
      });
    }

    // ✅ STEP 3: Let binderbyte handle ALL courier detection (removed regex patterns)
    if (!BINDER_KEY) {
      console.error('[RESI ERROR] BINDERBYTE_API_KEY not configured!');
      return res.status(503).json({
        error: "Layanan validasi resi sedang tidak tersedia",
        message: "Silakan coba lagi nanti"
      });
    }

    // ✅ STEP 4: Try all major couriers (let binderbyte API decide)
    const courierPriority = ['jne', 'jnt', 'sicepat', 'anteraja', 'ninja', 'pos', 'tiki', 'wahana', 'lion', 'rpx'];

    console.log(`[BINDERBYTE] Validating ${cleanResi} - trying all couriers...`);

    const validationStart = Date.now();
    let binderbyteResult = null;
    let validCourier = null;

    // ✅ STEP 5: TRY COURIERS IN SMART ORDER (stop on first success)
    for (const courier of courierPriority) {
      try {
        console.log(`[BINDERBYTE] Trying ${courier}...`);
        const apiStartTime = Date.now();

        // Build API params
        const apiParams = {
          api_key: BINDER_KEY,
          courier: courier,
          awb: cleanResi,
        };
        
        // JNE requires additional 5-digit number parameter
        if (courier === 'jne') {
          if (!jneNumber || !/^\d{5}$/.test(jneNumber.trim())) {
            console.log(`[BINDERBYTE] Skipping JNE - invalid/missing 5-digit number`);
            continue; // Skip JNE if number not provided or invalid
          }
          apiParams.number = jneNumber.trim();
          console.log(`[BINDERBYTE] JNE tracking with number: ${jneNumber}`);
        }

        const response = await axios.get("https://api.binderbyte.com/v1/track", {
          params: apiParams,
          timeout: 5000, // Reduced to 5s per courier
        });

        // Record external API metrics
        const apiDuration = (Date.now() - apiStartTime) / 1000;
        externalApiDuration.labels('binderbyte', 'track', response.data?.status || 'unknown').observe(apiDuration);

        if (response.data?.status === 200 && response.data.data?.summary) {
          binderbyteResult = response.data.data;
          validCourier = courier;

          const validationTime = Date.now() - validationStart;
          console.log(`[BINDERBYTE] ✅ FOUND: ${cleanResi} via ${courier.toUpperCase()} (${validationTime}ms)`);
          break; // Stop on first match
        }

      } catch (err) {
        // Continue to next courier
        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
          console.log(`[BINDERBYTE] ${courier}: Timeout`);
        } else if (err.response?.status === 404) {
          console.log(`[BINDERBYTE] ${courier}: Not found`);
        } else {
          console.log(`[BINDERBYTE] ${courier}: ${err.message}`);
        }
        continue;
      }
    }

    const totalTime = Date.now() - validationStart;

    // ✅ STEP 6: IF NOT FOUND IN BINDERBYTE
    if (!binderbyteResult || !validCourier) {
      console.error(`[BINDERBYTE] ❌ NOT FOUND: ${cleanResi} - not found in Binderbyte (${totalTime}ms)`);

      // 🔥 NEW: If we have HIGH CONFIDENCE pattern match, TRUST IT even if Binderbyte fails
      // This handles cases where:
      // - Binderbyte has incomplete courier data
      // - Resi is too new or too old for Binderbyte cache
      // - API integration delays
      if (highConfidence && courierPriority.length === 1) {
        const detectedCourier = courierPriority[0];
        console.log(`[BINDERBYTE] ✅ ACCEPTING HIGH CONFIDENCE match: ${detectedCourier.toUpperCase()} (Binderbyte unavailable)`);
        
        // Save to database with limited info (no Binderbyte tracking data)
        const tracking = await CustomerTracking.create({
          resi: cleanResi,
          courierType: detectedCourier,
          customerId: userId,
          note: `✅ Pattern-validated (Binderbyte unavailable)`,
          validated: true,
          validationAttempted: true,
          binderbyteData: {
            summary: {
              courier: detectedCourier,
              status: 'unknown',
              waybill: cleanResi
            },
            validatedAt: new Date(),
            note: 'Courier detected by HIGH CONFIDENCE pattern. External API unavailable.'
          }
        });

        return res.json({
          success: true,
          resi: cleanResi,
          courierType: detectedCourier,
          tracking: {
            _id: tracking._id,
            note: tracking.note,
            status: 'unknown',
            history: [],
            summary: {
              courier: detectedCourier,
              status: 'Nomor resi valid, tracking detail belum tersedia',
              waybill: cleanResi
            }
          },
          message: `✅ Nomor resi valid (${detectedCourier.toUpperCase()}). Detail tracking akan tersedia setelah paket di-pickup.`,
          validationMethod: 'HIGH_CONFIDENCE_PATTERN',
          warning: 'Detail tracking belum tersedia dari sistem ekspedisi'
        });
      }

      // No high confidence pattern - reject
      return res.status(404).json({
        error: "Nomor resi tidak ditemukan",
        resi: cleanResi,
        message: "Resi tidak ditemukan di sistem ekspedisi manapun. Pastikan nomor resi sudah benar dan paket sudah di-pickup kurir.",
        suggestion: "Periksa kembali nomor resi atau coba lagi nanti jika paket baru di-pickup"
      });
    }

    // ✅ STEP 7: SAVE TO DATABASE (only valid resi - this creates cache for future queries)
    const trackingData = {
      resi: cleanResi,
      courierType: validCourier,
      customerId: userId,
      note: `✅ Validated by Binderbyte`,
      validated: true,
      validationAttempted: true,
      binderbyteData: {
        summary: binderbyteResult.summary,
        validatedAt: new Date()
      }
    };
    
    // Save JNE number if JNE courier
    if (validCourier === 'jne' && jneNumber) {
      trackingData.jneNumber = jneNumber.trim();
    }
    
    const tracking = await CustomerTracking.create(trackingData);

    console.log(`[RESI SAVED] ✅ ${cleanResi} for customer ${userId} via ${validCourier.toUpperCase()}`);

    // ✅ STEP 8: SEND NOTIFICATION
    try {
      await sendNotificationToCustomer(
        userId,
        '✅ Resi Berhasil Ditambahkan',
        `Paket ${cleanResi} berhasil dilacak via ${validCourier.toUpperCase()}`,
        {
          type: 'resi_added',
          resi: cleanResi,
          courierType: validCourier,
          status: binderbyteResult.summary?.status || 'unknown'
        }
      );
    } catch (notifErr) {
      console.error('[NOTIFICATION] Failed:', notifErr.message);
    }

    // 🔥 NEW: Auto-assign available online locker (only customer's own lockers)
    let assignedLockerId = null;
    try {
      const availableLocker = await Locker.findOne({
        customerId: userId, // Only customer's own lockers
        status: 'online',
        isActive: true
      }).sort({ 'pendingResi.length': 1 }); // Least busy locker first

      if (availableLocker) {
        assignedLockerId = availableLocker.lockerId;
        tracking.assignedLockerId = assignedLockerId;
        tracking.lockerAssignedAt = new Date();
        await tracking.save();
        console.log(`[LOCKER ASSIGNED] ${assignedLockerId} auto-assigned to ${cleanResi} (customer: ${userId})`);
      } else {
        console.log(`[LOCKER ASSIGN] No online locker available for customer ${userId}`);
      }
    } catch (assignErr) {
      console.error('[LOCKER ASSIGN] Failed:', assignErr.message);
    }

    // ✅ STEP 9: RETURN SUCCESS WITH TRACKING DATA
    return res.json({
      ok: true,
      message: `Resi berhasil divalidasi via ${validCourier.toUpperCase()}`,
      data: {
        resi: cleanResi,
        courierType: validCourier,
        validated: true,
        assignedLockerId: assignedLockerId, // Include assigned locker
        tracking: {
          summary: binderbyteResult.summary,
          detail: binderbyteResult.detail,
          history: binderbyteResult.history
        },
        createdAt: tracking.createdAt
      }
    });

  } catch (err) {
    console.error("POST /api/customer/manual-resi error:", err);
    return res.status(500).json({
      error: "Gagal menyimpan resi",
      message: "Terjadi kesalahan internal server"
    });
  }
});
// Agent melihat semua resi manual dari user
app.get("/api/manual-resi", async (req, res) => {
  try {
    const list = await CustomerTracking.find({})
      .sort({ createdAt: -1 })
      .lean();
    
    // Check each resi's shipment status
    const enrichedList = await Promise.all(
      list.map(async (tracking) => {
        // Check if resi has been assigned to a shipment
        const shipment = await Shipment.findOne({ resi: tracking.resi });
        
        let resiStatus = 'active'; // Default: not yet assigned
        let statusReason = 'Belum diterima';
        
        if (shipment) {
          // Check shipment status
          if (shipment.status === 'completed' || shipment.status === 'delivered_to_customer') {
            resiStatus = 'inactive';
            statusReason = 'Sudah diterima customer';
          } else if (shipment.status === 'delivered_to_locker' || shipment.status === 'ready_for_pickup') {
            resiStatus = 'active'; // In locker, waiting for pickup
            statusReason = 'Di locker, menunggu pickup';
          } else if (shipment.status === 'pending_locker') {
            resiStatus = 'active'; // Assigned but not delivered yet
            statusReason = 'Sudah di-assign ke kurir';
          }
        }
        
        return {
          ...tracking,
          courierType: tracking.courierType || 'unknown',
          needsRevalidation: !tracking.courierType || tracking.courierType === 'unknown' || !tracking.validated,
          resiStatus, // 'active' or 'inactive'
          statusReason,
          shipmentStatus: shipment?.status || null,
          lockerId: shipment?.lockerId || null,
          deliveredAt: shipment?.deliveredToCustomerAt || null
        };
      })
    );
    
    res.json({ data: enrichedList });
  } catch (err) {
    console.error("GET /api/manual-resi error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Revalidate unknown resi (Admin/Agent endpoint)
app.post("/api/manual-resi/revalidate/:resi", async (req, res) => {
  try {
    const { resi } = req.params;
    const { jneNumber } = req.body; // Get JNE number from request body
    const cleanResi = resi.trim().toUpperCase();

    console.log(`[RESI REVALIDATE] Attempting to revalidate ${cleanResi}...`);

    const tracking = await CustomerTracking.findOne({ resi: cleanResi });
    if (!tracking) {
      return res.status(404).json({ error: "Resi tidak ditemukan di database" });
    }

    if (!BINDER_KEY) {
      return res.status(503).json({ error: "Binderbyte API key tidak tersedia" });
    }

    // Try smart courier detection
    let courierPriority = [];
    if (/^JT\d{10,}/i.test(cleanResi)) {
      courierPriority = ['jnt', 'jne', 'anteraja', 'sicepat', 'ninja', 'pos'];
    } else if (/^(JNE|CGK)/i.test(cleanResi)) {
      courierPriority = ['jne', 'jnt', 'anteraja', 'sicepat', 'ninja', 'pos'];
    } else if (/^\d{14}$/.test(cleanResi)) {
      courierPriority = ['anteraja', 'sicepat', 'jnt', 'jne', 'ninja', 'pos'];
    } else {
      courierPriority = ['jne', 'jnt', 'anteraja', 'sicepat', 'ninja', 'pos'];
    }

    let binderbyteResult = null;
    let validCourier = null;

    for (const courier of courierPriority) {
      try {
        console.log(`[REVALIDATE] Trying ${courier}...`);
        
        // Build API params
        const apiParams = {
          api_key: BINDER_KEY,
          courier: courier,
          awb: cleanResi,
        };
        
        // JNE requires additional 5-digit number parameter
        if (courier === 'jne') {
          if (!jneNumber || !/^\d{5}$/.test(jneNumber.trim())) {
            console.log(`[REVALIDATE] Skipping JNE - invalid/missing 5-digit number`);
            continue;
          }
          apiParams.number = jneNumber.trim();
          console.log(`[REVALIDATE] JNE tracking with number: ${jneNumber}`);
        }
        
        const response = await axios.get("https://api.binderbyte.com/v1/track", {
          params: apiParams,
          timeout: 5000,
        });

        if (response.data?.status === 200 && response.data.data?.summary) {
          binderbyteResult = response.data.data;
          validCourier = courier;
          console.log(`[REVALIDATE] ✅ Found as ${courier.toUpperCase()}`);
          break;
        }
      } catch (err) {
        console.log(`[REVALIDATE] ${courier}: ${err.message}`);
        continue;
      }
    }

    if (!validCourier) {
      return res.status(404).json({
        error: "Resi tidak ditemukan di sistem ekspedisi manapun",
        resi: cleanResi
      });
    }

    // Update tracking with validated data
    tracking.courierType = validCourier;
    tracking.validated = true;
    tracking.validationAttempted = true;
    tracking.note = `✅ Revalidated via ${validCourier.toUpperCase()}`;
    tracking.binderbyteData = {
      summary: binderbyteResult.summary,
      validatedAt: new Date()
    };
    
    // Save JNE number if JNE courier
    if (validCourier === 'jne' && jneNumber) {
      tracking.jneNumber = jneNumber.trim();
    }
    
    await tracking.save();

    console.log(`[REVALIDATE] ✅ Updated ${cleanResi} as ${validCourier.toUpperCase()}`);

    return res.json({
      ok: true,
      message: `Resi berhasil divalidasi ulang sebagai ${validCourier.toUpperCase()}`,
      data: {
        resi: cleanResi,
        courierType: validCourier,
        validated: true,
        tracking: binderbyteResult.summary
      }
    });

  } catch (err) {
    console.error("POST /api/manual-resi/revalidate error:", err);
    return res.status(500).json({ error: "Gagal revalidasi resi" });
  }
});

// Update weight for manual resi (Agent/Customer endpoint)
app.put("/api/manual-resi/:resi/weight", async (req, res) => {
  try {
    const { resi } = req.params;
    const { weight, weightSource } = req.body;
    const cleanResi = resi.trim().toUpperCase();

    // Validate weight
    const weightValue = parseFloat(weight);
    if (isNaN(weightValue) || weightValue < 0 || weightValue > 100) {
      return res.status(400).json({ 
        ok: false,
        error: "Weight harus antara 0-100 kg" 
      });
    }

    // Validate source
    const validSources = ['customer', 'esp32', 'courier'];
    if (weightSource && !validSources.includes(weightSource)) {
      return res.status(400).json({ 
        ok: false,
        error: `weightSource harus salah satu dari: ${validSources.join(', ')}` 
      });
    }

    console.log(`[WEIGHT UPDATE] ${cleanResi}: ${weightValue}kg from ${weightSource || 'unknown'}`);

    const tracking = await CustomerTracking.findOne({ resi: cleanResi });
    if (!tracking) {
      return res.status(404).json({ 
        ok: false,
        error: "Resi tidak ditemukan di database" 
      });
    }

    // Update weight
    tracking.weight = weightValue;
    tracking.weightRecordedAt = new Date();
    tracking.weightSource = weightSource || 'customer';
    await tracking.save();

    console.log(`[WEIGHT UPDATE] ✅ ${cleanResi} weight updated to ${weightValue}kg`);

    return res.json({
      ok: true,
      message: "Berat berhasil diupdate",
      data: {
        resi: cleanResi,
        weight: weightValue,
        weightSource: tracking.weightSource,
        weightRecordedAt: tracking.weightRecordedAt
      }
    });

  } catch (err) {
    console.error("PUT /api/manual-resi/:resi/weight error:", err);
    return res.status(500).json({ 
      ok: false,
      error: "Gagal update berat" 
    });
  }
});

// Delete manual resi (Agent only)
app.delete("/api/manual-resi/:resi", async (req, res) => {
  try {
    const { resi } = req.params;
    const cleanResi = resi.trim().toUpperCase();

    console.log(`[RESI DELETE] Deleting ${cleanResi}...`);

    // Check if resi exists
    const tracking = await CustomerTracking.findOne({ resi: cleanResi });
    if (!tracking) {
      return res.status(404).json({ error: "Resi tidak ditemukan" });
    }

    // Delete the tracking record
    await CustomerTracking.deleteOne({ resi: cleanResi });

    // Also delete shipment if exists (regardless of status)
    const shipment = await Shipment.findOne({ resi: cleanResi });
    if (shipment) {
      await Shipment.deleteOne({ resi: cleanResi });
      console.log(`[RESI DELETE] Also deleted shipment for ${cleanResi}`);
    }

    console.log(`[RESI DELETE] ✅ Deleted ${cleanResi}`);
    res.json({ 
      ok: true, 
      message: "Resi berhasil dihapus" 
    });

  } catch (err) {
    console.error("DELETE /api/manual-resi/:resi error:", err);
    return res.status(500).json({ error: "Gagal menghapus resi" });
  }
});

// 🔥 NEW: Get active validated resi for agent (with auto-fill data)
app.get("/api/agent/active-resi", async (req, res) => {
  try {
    const validatedResi = await CustomerTracking.find({
      validated: true,
      courierType: { $exists: true, $ne: 'unknown' }
    }).sort({ createdAt: -1 });

    const activeResi = [];
    
    for (const tracking of validatedResi) {
      // Check if resi is still active (not completed)
      const shipment = await Shipment.findOne({ resi: tracking.resi });
      
      // Include resi if:
      // - Not yet assigned to any shipment (null)
      // - AND not yet in locker (exclude delivered_to_locker, ready_for_pickup, completed, delivered_to_customer)
      const isActive = !shipment || 
                       !['delivered_to_locker', 'ready_for_pickup', 'completed', 'delivered_to_customer'].includes(shipment.status);
      
      if (isActive) {
        const customer = await User.findOne({ userId: tracking.customerId });
        
        // Get/assign locker (only customer's own lockers)
        let assignedLockerId = tracking.assignedLockerId;
        let lockerInfo = null;
        
        if (!assignedLockerId) {
          const availableLocker = await Locker.findOne({
            customerId: tracking.customerId, // Only that customer's own lockers
            status: 'online',
            isActive: true
          }).sort({ 'pendingResi.length': 1 });
          
          if (availableLocker) {
            assignedLockerId = availableLocker.lockerId;
            tracking.assignedLockerId = assignedLockerId;
            tracking.lockerAssignedAt = new Date();
            await tracking.save();
            lockerInfo = availableLocker;
            console.log(`[AUTO-ASSIGN] ${assignedLockerId} → ${tracking.resi} (customer: ${tracking.customerId})`);
          }
        } else {
          // Fetch locker info if already assigned
          lockerInfo = await Locker.findOne({ lockerId: assignedLockerId });
        }
        
        activeResi.push({
          resi: tracking.resi,
          courierType: tracking.courierType,
          customerId: tracking.customerId,
          customerName: customer?.name || 'Unknown',
          customerPhone: customer?.phone || '',
          assignedLockerId: assignedLockerId,
          lockerAssignedAt: tracking.lockerAssignedAt,
          // Add locker owner information for agent
          lockerOwnerName: lockerInfo?.ownerName || '',
          lockerOwnerAddress: lockerInfo?.ownerAddress || '',
          lockerOwnerPhone: lockerInfo?.ownerPhone || '',
          currentStatus: shipment?.status || 'not_assigned',
          validatedAt: tracking.createdAt,
          displayLabel: `${tracking.resi} - ${tracking.courierType.toUpperCase()} - ${customer?.name || 'Unknown'}${assignedLockerId ? ` - ${assignedLockerId}` : ''}`
        });
      }
    }

    res.json({
      ok: true,
      count: activeResi.length,
      data: activeResi
    });
  } catch (err) {
    console.error("GET /api/agent/active-resi error:", err);
    res.status(500).json({ error: "Failed to fetch active resi" });
  }
});

// 🔥 NEW: Agent update profile (name and address)
app.post("/api/agent/profile", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, address, phone } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: "Nama wajib diisi"
      });
    }

    if (!address || !address.trim()) {
      return res.status(400).json({
        success: false,
        error: "Alamat wajib diisi"
      });
    }

    // Find and update user
    const user = await User.findOne({ userId });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User tidak ditemukan"
      });
    }

    // Update profile
    user.name = name.trim();
    user.address = address.trim();
    if (phone && phone.trim()) {
      user.phone = phone.trim();
    }
    
    await user.save();

    console.log(`[AGENT PROFILE] Updated profile for agent ${userId}: ${name}`);

    res.json({
      success: true,
      message: "Profile berhasil diperbarui",
      data: {
        userId: user.userId,
        name: user.name,
        address: user.address,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (err) {
    console.error("POST /api/agent/profile error:", err);
    res.status(500).json({
      success: false,
      error: "Gagal memperbarui profile"
    });
  }
});

// 🔥 NEW: Agent get profile
app.get("/api/agent/profile", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const user = await User.findOne({ userId }).lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User tidak ditemukan"
      });
    }

    res.json({
      success: true,
      data: {
        userId: user.userId,
        name: user.name,
        address: user.address || '',
        phone: user.phone || '',
        email: user.email || '',
        role: user.role,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error("GET /api/agent/profile error:", err);
    res.status(500).json({
      success: false,
      error: "Gagal mengambil data profile"
    });
  }
});

// List semua shipment milik customer (pakai JWT) - Enhanced with weight info
app.get("/api/customer/shipments", auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const shipments = await Shipment.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .lean();

    // Enrich each shipment with formatted data
    const enrichedShipments = shipments.map(shipment => ({
      ...shipment,
      weightInfo: {
        weight: shipment.weight,
        weightKg: shipment.weight ? shipment.weight.toFixed(2) : null,
        unit: "kg",
        recorded: shipment.weight !== null && shipment.weight !== undefined,
        recordedAt: shipment.weightRecordedAt
      },
      trackingAvailable: shipment.logs && shipment.logs.length > 0
    }));

    res.json({ data: enrichedShipments });
  } catch (err) {
    console.error("GET /api/customer/shipments error:", err);
    res.status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// Get single shipment by resi (for detail view with tracking)
app.get("/api/customer/shipments/:resi", auth, async (req, res) => {
  try {
    const { resi } = req.params;
    const userId = req.user.userId;
    const cleanResi = resi.trim().toUpperCase();

    console.log(`[SHIPMENT DETAIL] Customer ${userId} requesting ${cleanResi}`);

    const shipment = await Shipment.findOne({ 
      resi: cleanResi,
      customerId: userId 
    }).lean();

    if (!shipment) {
      return res.status(404).json({
        ok: false,
        error: "Shipment tidak ditemukan atau bukan milik Anda"
      });
    }

    // Format tracking history from logs
    const trackingHistory = shipment.logs ? shipment.logs.map(log => ({
      event: log.event,
      timestamp: log.timestamp,
      description: formatEventDescription(log.event, log.extra),
      details: log.extra
    })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)) : [];

    // Get locker info
    const locker = await Locker.findOne({ lockerId: shipment.lockerId }).lean();

    return res.json({
      ok: true,
      data: {
        resi: shipment.resi,
        courierType: shipment.courierType,
        lockerId: shipment.lockerId,
        lockerInfo: locker ? {
          lockerId: locker.lockerId,
          ownerName: locker.ownerName,
          ownerAddress: locker.ownerAddress,
          status: locker.status
        } : null,
        status: shipment.status,
        statusLabel: formatStatusLabel(shipment.status),
        weight: {
          value: shipment.weight,
          formatted: shipment.weight ? `${shipment.weight.toFixed(2)} kg` : "Belum tercatat",
          recorded: shipment.weight !== null && shipment.weight !== undefined,
          recordedAt: shipment.weightRecordedAt
        },
        tracking: {
          available: trackingHistory.length > 0,
          history: trackingHistory,
          count: trackingHistory.length
        },
        dates: {
          created: shipment.createdAt,
          deliveredToLocker: shipment.deliveredToLockerAt,
          deliveredToCustomer: shipment.deliveredToCustomerAt,
          pickedUp: shipment.pickedUpAt
        },
        receiver: {
          name: shipment.receiverName,
          phone: shipment.receiverPhone
        },
        courier: {
          name: shipment.courierName,
          plate: shipment.courierPlate,
          type: shipment.courierType
        }
      }
    });

  } catch (err) {
    console.error("GET /api/customer/shipments/:resi error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal mengambil detail shipment"
    });
  }
});

// Helper function to format event descriptions
function formatEventDescription(event, extra) {
  const descriptions = {
    'assigned_to_locker': 'Paket ditugaskan ke locker',
    'courier_scanned': 'Kurir scan QR code',
    'locker_opened': 'Locker dibuka',
    'delivered_to_locker': 'Paket diterima di locker',
    'weight_recorded': 'Berat paket tercatat',
    'weight_recorded_differential': 'Berat paket tercatat (sensor)',
    'customer_opened': 'Customer buka locker',
    'delivered_to_customer': 'Paket diambil customer',
    'completed': 'Pengiriman selesai'
  };

  let desc = descriptions[event] || event;
  
  // Add extra details if available
  if (extra) {
    if (extra.weight) {
      desc += ` (${extra.weight} kg)`;
    }
    if (extra.packageWeight) {
      desc += ` (${extra.packageWeight} kg)`;
    }
  }

  return desc;
}

// Helper function to format status labels
function formatStatusLabel(status) {
  const labels = {
    'pending_locker': 'Menunggu kurir',
    'assigned_to_locker': 'Ditugaskan ke locker',
    'delivered_to_locker': 'Di locker',
    'ready_for_pickup': 'Siap diambil',
    'delivered_to_customer': 'Sudah diambil',
    'completed': 'Selesai'
  };

  return labels[status] || status;
}

// 🔥 NEW: Customer update profile (name, phone, address)
app.post("/api/customer/profile", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, phone, address } = req.body;

    const user = await User.findOne({ userId });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User tidak ditemukan"
      });
    }

    // Update profile fields
    if (name && name.trim()) {
      user.name = name.trim();
    }
    if (phone && phone.trim()) {
      user.phone = phone.trim();
    }
    if (address && address.trim()) {
      user.address = address.trim();
    }
    
    await user.save();

    console.log(`[CUSTOMER PROFILE] Updated profile for customer ${userId}`);

    res.json({
      success: true,
      message: "Profile berhasil diperbarui",
      data: {
        userId: user.userId,
        name: user.name,
        phone: user.phone,
        address: user.address,
        email: user.email
      }
    });
  } catch (err) {
    console.error("POST /api/customer/profile error:", err);
    res.status(500).json({
      success: false,
      error: "Gagal memperbarui profile"
    });
  }
});

// 🔥 NEW: Customer get profile
app.get("/api/customer/profile", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const user = await User.findOne({ userId }).lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User tidak ditemukan"
      });
    }

    res.json({
      success: true,
      data: {
        userId: user.userId,
        name: user.name,
        phone: user.phone || '',
        address: user.address || '',
        email: user.email || '',
        role: user.role,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error("GET /api/customer/profile error:", err);
    res.status(500).json({
      success: false,
      error: "Gagal mengambil data profile"
    });
  }
});

// Customer minta buka locker untuk resi tertentu
app.post("/api/customer/open-locker", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { resi, courierType } = req.body;

    if (!resi || ! courierType) {
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

// Detail tracking 1 resi (Binderbyte + internal) - FIXED with auto-detect
app.get("/api/customer/track/:resi", async (req, res) => {
  const { resi } = req.params;
  const { courier } = req.query; // Optional now

  try {
    console.log(`[TRACKING REQUEST] Resi: ${resi}, Courier: ${courier || 'auto-detect'}`);

    // Find shipment in database
    const shipment = await Shipment.findOne({ resi }).lean();

    // Find in customer_trackings
    const tracking = await CustomerTracking.findOne({ resi }).lean();

    console.log(`[TRACKING] Shipment found: ${!!shipment}, Tracking found: ${!!tracking}`);

    // Auto-detect courier type from multiple sources
    let courierType = courier ||
                      shipment?.courierType ||
                      tracking?.courierType;

    console.log(`[TRACKING] Detected courier type: ${courierType}`);

    // If still no courier type, try to detect from resi or default to anteraja
    if (!courierType || courierType === 'unknown') {
      // Try common courier detection based on resi pattern
      if (resi.length === 14 && resi.startsWith('1')) {
        courierType = 'anteraja';
        console.log(`[TRACKING] Auto-detected anteraja from resi pattern`);
      } else {
        // Default to anteraja and let Binderbyte figure it out
        courierType = 'anteraja';
        console.log(`[TRACKING] Defaulting to anteraja`);
      }
    }

    // Prepare internal data
    const internalData = {
      shipment: shipment || null,
      tracking: tracking || null,
      found: !!(shipment || tracking),
    };

    // FAST RESPONSE: Return internal data immediately if no Binderbyte or if it might be slow
    const shouldFetchBinderbyte = BINDER_KEY && req.query.external !== 'false';

    if (!shouldFetchBinderbyte) {
      console.log(`[TRACKING] Returning internal data only (Binderbyte skipped)`);
      return res.json({
        ok: true,
        resi,
        courierType,
        internal: internalData,
        binderbyte: null,
        hasBinderbyte: false,
        message: "Data internal (Binderbyte dinonaktifkan untuk kecepatan)",
      });
    }

    // Try Binderbyte with shorter timeout for mobile
    let binderbyte = null;
    let usingCachedData = false;

    try {
      console.log(`[TRACKING] Fetching ${resi} from Binderbyte (${courierType})...`);

      // Build API params
      const apiParams = {
        api_key: BINDER_KEY,
        courier: courierType,
        awb: resi,
      };
      
      // JNE requires additional 5-digit number parameter
      if (courierType === 'jne' && tracking?.jneNumber) {
        apiParams.number = tracking.jneNumber;
        console.log(`[TRACKING] JNE tracking with number: ${tracking.jneNumber}`);
      } else if (courierType === 'jne' && req.query.jneNumber) {
        apiParams.number = req.query.jneNumber;
        console.log(`[TRACKING] JNE tracking with number from query: ${req.query.jneNumber}`);
      }

      const bbResp = await axios.get("https://api.binderbyte.com/v1/track", {
        params: apiParams,
        timeout: 15000, // Reduced to 15 seconds for faster mobile response
      });

      if (bbResp.data && bbResp.data.status === 200) {
        binderbyte = bbResp.data.data;
        console.log(`[TRACKING] ✅ Live data from Binderbyte for ${resi}`);
      } else {
        console.log(`[TRACKING] ⚠️ No data from Binderbyte for ${resi}`);
      }
    } catch (bbErr) {
      console.error(`[TRACKING] Binderbyte error for ${resi}:`, bbErr.message);
      console.error(`[TRACKING] Error code:`, bbErr.code);
      console.error(`[TRACKING] Error details:`, bbErr.response?.status || 'No response');

      // 🔥 FALLBACK: Use cached Binderbyte data from customer_trackings if available
      if (tracking?.binderbyteData?.summary) {
        binderbyte = {
          summary: tracking.binderbyteData.summary,
          detail: [],
          history: [],
          cached: true,
          cachedAt: tracking.binderbyteData.validatedAt
        };
        usingCachedData = true;
        console.log(`[TRACKING] ✅ Using cached Binderbyte data from ${tracking.binderbyteData.validatedAt}`);
      } else {
        // Still return success with internal data even if Binderbyte fails
        binderbyte = {
          error: true,
          message: "Layanan tracking eksternal sedang sibuk. Data internal tetap tersedia.",
          code: bbErr.code || 'TIMEOUT',
          details: bbErr.message
        };
      }
    }

    // Return combined data - ALWAYS return success with internal data
    res.json({
      ok: true,
      resi,
      courierType,
      internal: internalData,
      binderbyte: binderbyte,
      hasBinderbyte: (binderbyte && !binderbyte.error) || usingCachedData,
      usingCachedData: usingCachedData,
      message: binderbyte?.error 
        ? "Data tracking internal tersedia (eksternal timeout)" 
        : usingCachedData 
        ? "Menggunakan data tracking yang tersimpan (cache)"
        : undefined,
    });

  } catch (err) {
    console.error("GET /api/customer/track/:resi error:", err);
    res.status(500).json({
      ok: false,
      error: "Gagal mengambil data tracking",
      detail: err.message,
      resi: resi,
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
    res.status(500). json({ error: "Internal server error" });
  }
});

// Tambah kurir baru
app. post("/api/couriers", async (req, res) => {
  try {
    let { name, company, plate } = req.body;

    if (!name || !company || !plate) {
      return res
        .status(400)
        . json({ error: "name, company, dan plate wajib diisi" });
    }

    name = name.trim();
    company = company.trim(). toLowerCase();
    plate = plate.trim().toUpperCase();

    const exists = await Courier.findOne({ plate, company });
    if (exists) {
      return res. status(400).json({
        error: "Kurir dengan plat & perusahaan ini sudah terdaftar",
      });
    }

    const courier = await Courier.create({
      courierId: "CR-" + company.toUpperCase(). slice(0, 3) + "-" + Date.now(),
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
      return res. status(400).json({ error: "Invalid state.  Must be: active, ongoing, or inactive" });
    }

    const courier = await Courier.findOneAndUpdate(
      { courierId },
      { state },
      { new: true }
    );

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    console.log(`[AGENT] Courier ${courierId} state changed to: ${state}`);

    res.json({
      ok: true,
      message: `Status kurir diupdate menjadi ${state}`,
      data: courier,
    });
  } catch (err) {
    console.error("PUT /api/couriers/:courierId/status error:", err);
    res. status(500).json({ error: "Internal server error" });
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

// ==================== COURIER REGISTRATION & AUTH ====================

// Courier Registration - Simple with name only
app.post("/api/courier/register", async (req, res) => {
  try {
    const { name, company, plate, phone, password } = req.body;

    // Validation
    if (!name || !company || !plate || !password) {
      return res.status(400).json({
        error: "Nama, perusahaan, plat kendaraan, dan password wajib diisi",
      });
    }

    // Normalize data
    const normalizedPlate = plate.trim().toUpperCase();
    const normalizedCompany = company.trim().toLowerCase();

    // Check if plate already exists for this company
    const existingPlate = await Courier.findOne({
      plate: normalizedPlate,
      company: normalizedCompany,
    });

    if (existingPlate) {
      return res.status(400).json({
        error: "Plat kendaraan ini sudah terdaftar untuk perusahaan yang sama",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate courier ID
    const courierId = `CR-${normalizedCompany.toUpperCase().slice(0, 3)}-${Date.now()}`;

    // Create courier
    const courier = await Courier.create({
      courierId,
      name: name.trim(),
      company: normalizedCompany,
      plate: normalizedPlate,
      phone: phone?.trim() || "",
      passwordHash,
      state: "active",
      lastActiveAt: new Date(),
    });

    console.log(`[COURIER REGISTER] ${courierId} (${name}) - ACTIVE`);

    return res.json({
      message: "Registrasi berhasil! Akun langsung aktif.",
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        state: courier.state,
      },
    });
  } catch (err) {
    console.error("POST /api/courier/register error:", err);
    return res.status(500).json({ error: "Gagal melakukan registrasi" });
  }
});

// Courier Login - Use NAME + password
app.post("/api/courier/login", async (req, res) => {
  try {
    const { name, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: "Nama dan password wajib diisi" });
    }

    const normalizedName = name.trim().toLowerCase();

    // Find courier by name (case-insensitive)
    const courier = await Courier.findOne({
      name: { $regex: new RegExp(`^${normalizedName}$`, 'i') }
    });

    if (!courier) {
      return res.status(401).json({
        error: "Nama tidak ditemukan. Silakan registrasi terlebih dahulu."
      });
    }

    // Check password
    if (!courier.passwordHash) {
      return res.status(401).json({
        error: "Akun ini belum memiliki password. Hubungi admin.",
      });
    }

    const passwordValid = await bcrypt.compare(password, courier.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Password salah" });
    }

    // Check courier state
    if (courier.state === "inactive") {
      return res.status(403).json({
        error: "Akun tidak aktif. Silakan hubungi admin.",
      });
    }

    // Update last active
    courier.lastActiveAt = new Date();
    if (courier.state === "inactive") {
      courier.state = "active";
      courier.inactiveSince = null;
    }
    await courier.save();

    // Generate JWT token
    const token = jwt.sign(
      {
        courierId: courier.courierId,
        name: courier.name,
        plate: courier.plate,
        company: courier.company,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    console.log(`[COURIER LOGIN] ${courier.courierId} (${courier.name}) logged in`);

    return res.json({
      message: "Login berhasil",
      token,
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        state: courier.state,
      },
    });
  } catch (err) {
    console.error("POST /api/courier/login error:", err);
    return res.status(500).json({ error: "Gagal login" });
  }
});

// Courier Profile (protected route)
app.get("/api/courier/profile", authCourier, async (req, res) => {
  try {
    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    }).lean();

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    // Get courier stats
    const totalDeliveries = await Shipment.countDocuments({
      courierId: courier.courierId,
      status: "delivered_to_locker",
    });

    const pendingDeliveries = await Shipment.countDocuments({
      courierId: courier.courierId,
      status: "pending_locker",
    });

    return res.json({
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        phone: courier.phone,
        state: courier.state,
        stats: {
          totalDeliveries,
          pendingDeliveries,
        },
      },
    });
  } catch (err) {
    console.error("GET /api/courier/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Update Courier Profile
app.put("/api/courier/profile", authCourier, async (req, res) => {
  try {
    const { name, phone } = req.body;

    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    });

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    if (name) courier.name = name.trim();
    if (phone) courier.phone = phone.trim();

    await courier.save();

    return res.json({
      message: "Profile berhasil diupdate",
      data: {
        courierId: courier.courierId,
        name: courier.name,
        phone: courier.phone,
      },
    });
  } catch (err) {
    console.error("PUT /api/courier/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Change Courier Password
app.post("/api/courier/change-password", authCourier, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        error: "Password lama dan password baru wajib diisi",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password baru minimal 6 karakter",
      });
    }

    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    });

    if (!courier || !courier.passwordHash) {
      return res.status(404).json({ error: "Courier not found" });
    }

    // Verify old password
    const passwordValid = await bcrypt.compare(oldPassword, courier.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Password lama salah" });
    }

    // Hash new password
    courier.passwordHash = await bcrypt.hash(newPassword, 10);
    await courier.save();

    console.log(`[COURIER] ${courier.courierId} changed password`);

    return res.json({
      message: "Password berhasil diubah",
    });
  } catch (err) {
    console.error("POST /api/courier/change-password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== OLD COURIER LOGIN (kept for backward compatibility) ====================

// Kurir login (OLD - name + plate method, kept for legacy apps)
app.post("/api/courier/login-legacy", async (req, res) => {
  try {
    const { name, plate } = req.body;
    if (!name || !plate) {
      return res. status(400).json({ error: "name dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    const courier = await Courier. findOne({
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
        .json({ error: "Kurir sudah tidak aktif.  Hubungi admin untuk aktivasi kembali." });
    }

    if (courier.name. toLowerCase() !== name.trim(). toLowerCase()) {
      return res. status(401).json({ error: "Nama kurir tidak sesuai" });
    }

    const exist = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
    });
    if (! exist) {
      return res. status(401).json({
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

// 🔹 Kurir deposit paket pakai lockerToken + resi (FIXED)
app.post("/api/courier/deposit-token", async (req, res) => {
  const requestStartTime = Date.now();
  const requestId = `SCAN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { lockerId, lockerToken, resi, weight } = req.body; // Added weight parameter

    console.log(`\n========================================`);
    console.log(`[🔍 COURIER SCAN START] RequestID: ${requestId}`);
    console.log(`[📥 REQUEST] Time: ${new Date().toISOString()}`);
    console.log(`[📥 REQUEST] LockerId: ${lockerId}`);
    console.log(`[📥 REQUEST] Resi: ${resi}`);
    console.log(`[📥 REQUEST] Weight: ${weight ? `${weight} kg` : 'NOT PROVIDED ⚠️'}`);
    console.log(`[📥 REQUEST] Token: ${lockerToken?.substring(0, 15)}...`);
    console.log(`========================================\n`);

    if (!lockerId || ! lockerToken || !resi) {
      const errorTime = Date.now() - requestStartTime;
      console.log(`[❌ VALIDATION FAILED] ${requestId}`);
      console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 400)`);
      console.log(`[📊 FIELDS] lockerId=${!!lockerId}, token=${!!lockerToken}, resi=${!!resi}\n`);
      
      return res. status(400).json({
        error: "lockerId, lockerToken, dan resi wajib diisi",
        requestId,
        responseTime: `${errorTime}ms`
      });
    }

    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      const errorTime = Date.now() - requestStartTime;
      console.log(`[❌ LOCKER NOT FOUND] ${requestId}`);
      console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 404)\n`);
      
      return res.status(404).json({ 
        error: "Locker tidak ditemukan",
        requestId,
        responseTime: `${errorTime}ms`
      });
    }

    console.log(`[✅ LOCKER FOUND] ${lockerId} - Status: ${locker.status}`);

    // Validasi lockerToken (QR dari ESP32)
    if (! locker.lockerToken || locker.lockerToken !== lockerToken. trim()) {
      const errorTime = Date.now() - requestStartTime;
      console.log(`[❌ TOKEN MISMATCH] ${requestId}`);
      console.log(`[🔑 TOKEN] Expected: ${locker.lockerToken}`);
      console.log(`[🔑 TOKEN] Got: ${lockerToken}`);
      console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 400)\n`);
      
      return res
        .status(400)
        .json({ 
          error: "Locker token tidak valid / kadaluarsa",
          requestId,
          responseTime: `${errorTime}ms`
        });
    }

    console.log(`[✅ TOKEN VALID] Token matched`);

    // IMPROVED: Check shipment first to give better error messages
    let shipment = await Shipment.findOne({
      resi,
      lockerId,
    });

    console.log(`[🔍 SHIPMENT SEARCH] Resi: ${resi}, LockerId: ${lockerId}`);

    // If not found by lockerId, try to find by resi only and check compatibility
    if (!shipment) {
      shipment = await Shipment.findOne({ resi });

      if (shipment) {
        // Shipment exists but for different locker
        const errorTime = Date.now() - requestStartTime;
        console.log(`[❌ WRONG LOCKER] ${requestId}`);
        console.log(`[📦 SHIPMENT] Expected locker: ${shipment.lockerId}`);
        console.log(`[📦 SHIPMENT] Scanned locker: ${lockerId}`);
        console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 400)\n`);
        
        return res.status(400).json({
          error: `Resi ini ditugaskan ke locker ${shipment.lockerId}, bukan ${lockerId}. Pastikan scan QR locker yang benar.`,
          expectedLockerId: shipment.lockerId,
          scannedLockerId: lockerId,
          requestId,
          responseTime: `${errorTime}ms`
        });
      }

      // Shipment doesn't exist at all
      const errorTime = Date.now() - requestStartTime;
      console.log(`[❌ SHIPMENT NOT FOUND] ${requestId}`);
      console.log(`[📦 RESI] ${resi} tidak ditemukan di sistem`);
      console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 404)\n`);
      
      return res.status(404).json({
        error: "Tidak ada paket dengan resi ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        lockerId,
        resi,
        requestId,
        responseTime: `${errorTime}ms`
      });
    }

    console.log(`[✅ SHIPMENT FOUND] Resi: ${resi}, Status: ${shipment.status}`);

    // Check shipment status
    if (shipment.status !== "pending_locker") {
      const errorTime = Date.now() - requestStartTime;
      console.log(`[❌ INVALID STATUS] ${requestId}`);
      console.log(`[📦 STATUS] Current: ${shipment.status} (Expected: pending_locker)`);
      console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 400)\n`);
      
      return res.status(400).json({
        error: `Paket sudah ${shipment.status === "delivered_to_locker" ? "diantar" : "diproses"}. Status: ${shipment.status}`,
        currentStatus: shipment.status,
        requestId,
        responseTime: `${errorTime}ms`
      });
    }

    console.log(`[✅ STATUS VALID] pending_locker → processing deposit...`);

    // Auto-fix: Add to pendingResi if not already there
    if (! locker.pendingResi. includes(resi)) {
      console.log(`[🔧 AUTO-FIX] Adding ${resi} to pendingResi for ${lockerId}`);
      locker.pendingResi.push(resi);
    }

    console.log(`[💾 UPDATING] Shipment status & locker command...`);

    // 📊 STORE WEIGHT DATA IF PROVIDED
    if (weight && !isNaN(weight) && weight > 0) {
      shipment.weight = parseFloat(weight.toFixed(3)); // Store weight in kg (3 decimals)
      shipment.weightRecordedAt = new Date();
      console.log(`[⚖️  WEIGHT RECORDED] ${weight}kg for resi ${resi}`);
    } else {
      console.log(`[⚠️  NO WEIGHT] Weight not provided or invalid: ${weight}`);
    }

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { 
        source: "courier_deposit_token", 
        requestId,
        weight: weight || null // Include weight in logs
      },
    });
    await shipment.save();

    console.log(`[✅ SHIPMENT UPDATED] Status: delivered_to_locker`);

    // 🔹 STORE COURIER HISTORY BEFORE ROTATING TOKEN
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory. push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: lockerToken, // Store the old token that was used
    });

    console.log(`[📝 COURIER HISTORY] Added: ${shipment.courierName || 'Unknown'} (${shipment.courierPlate || 'N/A'})`);

    // Command untuk ESP32
    locker.command = {
      type: "open",
      resi,
      source: "courier_token",
      createdAt: new Date(),
      customerId: shipment.customerId || "",
    };

    console.log(`[🚪 LOCKER COMMAND] Set to OPEN`);

    // Remove from pendingResi
    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);

    // 🔹 ROTATE TOKEN AFTER SUCCESSFUL DEPOSIT
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[🔄 TOKEN ROTATED] ${oldToken?.substring(0, 15)}... → ${locker.lockerToken?.substring(0, 15)}...`);

    // Recalc courier state
    if (shipment.courierId) {
      await recalcCourierState(shipment. courierId);
      console.log(`[👤 COURIER STATE] Recalculated for ${shipment.courierId}`);
    }

    const successTime = Date.now() - requestStartTime;
    
    console.log(`\n========================================`);
    console.log(`[✅ DEPOSIT SUCCESS] ${requestId}`);
    console.log(`[⏱️  RESPONSE TIME] ${successTime}ms (Status: 200)`);
    console.log(`[📦 RESULT] Resi: ${resi} → Locker: ${lockerId}`);
    console.log(`[⚖️  WEIGHT] ${shipment.weight ? `${shipment.weight}g` : 'Not recorded'}`);
    console.log(`[🔑 NEW TOKEN] ${locker.lockerToken?.substring(0, 15)}...`);
    console.log(`========================================\n`);

    return res.json({
      ok: true,
      message: "Deposit berhasil, locker akan dibuka, token telah dirotasi",
      requestId,
      responseTime: `${successTime}ms`,
      data: {
        lockerId,
        resi,
        customerId: shipment.customerId || "",
        weight: shipment.weight || null, // Include weight in response
        weightRecordedAt: shipment.weightRecordedAt || null,
        oldToken, // For debugging
        newToken: locker.lockerToken,
      },
    });
  } catch (err) {
    const errorTime = Date.now() - requestStartTime;
    console.log(`\n========================================`);
    console.log(`[💥 EXCEPTION ERROR] ${requestId}`);
    console.log(`[⏱️  RESPONSE TIME] ${errorTime}ms (Status: 500)`);
    console.log(`[❌ ERROR] ${err.message}`);
    console.log(`[📚 STACK] ${err.stack}`);
    console.log(`========================================\n`);
    
    console. error("POST /api/courier/deposit-token error:", err);
    return res.status(500).json({ 
      error: "Internal server error",
      requestId,
      responseTime: `${errorTime}ms`
    });
  }
});

// Kurir deposit via scan QR token + plat (old method - kept for backward compatibility)
app.post("/api/courier/deposit", async (req, res) => {
  try {
    const { lockerToken, plate } = req.body;

    console.log(`[COURIER DEPOSIT-PLATE] Attempt: plate=${plate}, token=${lockerToken?.substring(0, 15)}...`);

    if (!lockerToken || !plate) {
      console.log(`[COURIER DEPOSIT-PLATE] Missing fields: token=${!!lockerToken}, plate=${!!plate}`);
      return res
        .status(400)
        .json({ error: "lockerToken dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim(). toUpperCase();

    const locker = await Locker.findOne({ lockerToken: lockerToken.trim() });
    if (!locker) {
      console.log(`[COURIER DEPOSIT-PLATE] Token not found: ${lockerToken}`);
      return res
        .status(404)
        .json({ error: "Locker dengan token ini tidak ditemukan" });
    }

    console.log(`[COURIER DEPOSIT-PLATE] Locker found: ${locker.lockerId}, searching for plate: ${normalizedPlate}`);

    const shipment = await Shipment. findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
      lockerId: locker.lockerId,
    });

    if (!shipment) {
      // Enhanced debugging: check what shipments exist
      const allShipmentsForLocker = await Shipment.find({
        lockerId: locker.lockerId,
        status: "pending_locker"
      }).lean();

      const allShipmentsForPlate = await Shipment.find({
        courierPlate: normalizedPlate,
        status: "pending_locker"
      }).lean();

      console.log(`[COURIER DEPOSIT-PLATE] ERROR - No match found`);
      console.log(`[COURIER DEPOSIT-PLATE] - Pending for locker "${locker.lockerId}": ${allShipmentsForLocker.length} shipments`);
      if (allShipmentsForLocker.length > 0) {
        console.log(`[COURIER DEPOSIT-PLATE]   Available plates: ${allShipmentsForLocker.map(s => s.courierPlate || 'NONE').join(', ')}`);
      }
      console.log(`[COURIER DEPOSIT-PLATE] - Pending for plate "${normalizedPlate}": ${allShipmentsForPlate.length} shipments`);
      if (allShipmentsForPlate.length > 0) {
        console.log(`[COURIER DEPOSIT-PLATE]   Assigned lockers: ${allShipmentsForPlate.map(s => s.lockerId).join(', ')}`);
      }

      return res.status(404).json({
        error:
          "Tidak ada paket pending untuk plat ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        debug: {
          yourPlate: normalizedPlate,
          scannedLocker: locker.lockerId,
          pendingForThisLocker: allShipmentsForLocker.length,
          pendingForYourPlate: allShipmentsForPlate.length,
        }
      });
    }

    console.log(`[COURIER DEPOSIT-PLATE] Match found! Resi: ${shipment.resi}`);

    // ✅ Update courier activity
    await updateCourierActivity(shipment.courierId);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_plate" },
    });
    await shipment.save();

    // 🔹 STORE COURIER HISTORY BEFORE ROTATING TOKEN
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory.push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: normalizedPlate,
      resi: shipment.resi,
      deliveredAt: new Date(),
      usedToken: lockerToken,
    });

    locker.pendingResi = locker.pendingResi.filter((r) => r !== shipment.resi);
    locker.command = {
      type: "open",
      resi: shipment.resi,
      source: "courier",
      createdAt: new Date(),
    };

    // 🔹 ROTATE TOKEN AFTER SUCCESSFUL DEPOSIT
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + locker.lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[TOKEN ROTATE] ${locker.lockerId}: ${oldToken} → ${locker.lockerToken}`);

    // Recalc courier state after delivery (stays ongoing until all delivered to customer)
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    return res.json({
      message: "Locker akan dibuka untuk paket ini, token telah dirotasi",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      courierPlate: normalizedPlate,
      oldToken,
      newToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("POST /api/courier/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir: ambil daftar shipment (simplified - no per-resi token)
app.get("/api/courier/tasks", async (req, res) => {
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

    // 🔥 Enrich with customer info (phone number, name, locker address)
    const enrichedData = await Promise.all(
      shipments.map(async (s) => {
        // Get customer info
        const customer = await User.findOne({ userId: s.customerId }).lean();
        
        // Get locker info (for owner address)
        const locker = await Locker.findOne({ lockerId: s.lockerId }).lean();
        
        return {
          shipmentId: s._id,
          resi: s.resi,
          lockerId: s.lockerId,
          courierType: s.courierType,
          courierPlate: s.courierPlate,
          customerId: s.customerId,
          // ✅ Add customer info for courier
          customerName: customer?.name || '',
          customerPhone: customer?.phone || '',
          // ✅ Add locker owner info for delivery address
          lockerOwnerName: locker?.ownerName || '',
          lockerOwnerAddress: locker?.ownerAddress || '',
          lockerOwnerPhone: locker?.ownerPhone || '',
          status: s.status,
          createdAt: s.createdAt,
        };
      })
    );

    return res.json({
      ok: true,
      count: enrichedData.length,
      data: enrichedData,
    });
  } catch (err) {
    console.error("GET /api/courier/tasks error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir deposit paket - SIMPLIFIED: only needs lockerToken + resi
// Implements ONE-TIME TOKEN with courier history tracking
app.post("/api/courier/deposit-resi", async (req, res) => {
  try {
    const { lockerId, lockerToken, resi, debug, scanAtClient } = req.body;

    console.log(`[COURIER DEPOSIT-RESI] Attempt: lockerId=${lockerId}, resi=${resi}, token=${lockerToken?.substring(0, 15)}..., debug=${debug}`);

    if (!lockerId || !lockerToken || ! resi) {
      console.log(`[COURIER DEPOSIT-RESI] Missing fields: lockerId=${!!lockerId}, token=${!!lockerToken}, resi=${!!resi}`);
      return res.status(400).json({
        error: "lockerId, lockerToken, dan resi wajib diisi",
      });
    }

    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker tidak ditemukan" });
    }

    // 🔍 DEBUG: tandai waktu scan di backend (dan optional dari client)
    if (debug) {
      const clientTime = scanAtClient ? new Date(scanAtClient) : null;
      locker.debugInfo = locker.debugInfo || {};
      locker.debugInfo.enabled = true;
      locker.debugInfo.resi = resi;
      locker.debugInfo.scanAtBackend = new Date();
      if (clientTime) locker.debugInfo.scanAtClient = clientTime;

      console.log(
        `[DEBUG-QR] START locker=${lockerId} resi=${resi} scanAtBackend=${locker.debugInfo.scanAtBackend.toISOString()}` +
          (clientTime ? ` scanAtClient=${clientTime.toISOString()}` : "")
      );
    }

    // Validasi lockerToken (QR dari ESP32)
    if (!locker.lockerToken || locker.lockerToken !== lockerToken.trim()) {
      console.log(`[TOKEN VALIDATE] ${lockerId}: Token validation failed`);
      return res
        .status(400)
        .json({ error: "Invalid or expired token" });
    }

    // IMPROVED: Check shipment first to give better error messages
    let shipment = await Shipment.findOne({
      resi,
      lockerId,
    });

    // If not found by lockerId, try to find by resi only and check compatibility
    if (!shipment) {
      shipment = await Shipment.findOne({ resi });

      if (shipment) {
        // Shipment exists but for different locker
        console.log(`[DEPOSIT ERROR] Resi ${resi} assigned to locker ${shipment.lockerId}, not ${lockerId}`);
        return res.status(400).json({
          error: `Resi ini ditugaskan ke locker ${shipment.lockerId}, bukan ${lockerId}. Pastikan scan QR locker yang benar.`,
          expectedLockerId: shipment.lockerId,
          scannedLockerId: lockerId,
        });
      }

      // Shipment doesn't exist at all
      console.log(`[DEPOSIT ERROR] Resi ${resi} tidak ditemukan di sistem`);
      return res.status(404).json({
        error: "Tidak ada paket dengan resi ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        lockerId,
        resi,
      });
    }

    // Check shipment status
    if (shipment.status !== "pending_locker") {
      console.log(`[DEPOSIT ERROR] Resi ${resi} status: ${shipment.status}`);
      return res.status(400).json({
        error: `Paket sudah ${shipment.status === "delivered_to_locker" ? "diantar" : "diproses"}. Status: ${shipment.status}`,
        currentStatus: shipment.status,
      });
    }

    // Auto-fix: Add to pendingResi if not already there
    if (! locker.pendingResi. includes(resi)) {
      console.log(`[AUTO-FIX] Adding ${resi} to pendingResi for ${lockerId}`);
      locker.pendingResi.push(resi);
    }

    console.log(`[DEPOSIT] Processing resi ${resi} for locker ${lockerId}`);

    // ✅ Update courier activity
    await updateCourierActivity(shipment.courierId);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_resi" },
    });
    await shipment.save();

    // command untuk ESP32
    locker. command = {
      type: "open",
      resi,
      source: "courier_resi",
      createdAt: new Date(),
      customerId: shipment.customerId || "",
    };

    // Remove from pendingResi
    locker. pendingResi = locker. pendingResi.filter((r) => r !== resi);

    // ========== ONE-TIME TOKEN: Record courier history and rotate token ==========
    const oldToken = locker.lockerToken;

    // Add courier delivery to history
    locker.courierHistory. push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: oldToken, // Store the token that was used
    });

    // Rotate token - generate new unique token
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker. save();

    console.log(`[TOKEN ROTATE] ${lockerId}: Token rotated successfully`);
    
    // Track locker operation metrics
    lockerOperations.labels('deposit', lockerId, 'success').inc();
    qrScans.labels('courier', 'success').inc();

    // Recalc courier state
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    return res.json({
      ok: true,
      message: "Deposit berhasil, locker akan dibuka",
      data: {
        lockerId,
        resi,
        customerId: shipment.customerId || "",
      },
    });
  } catch (err) {
    console. error("POST /api/courier/deposit-resi error:", err);
    qrScans.labels('courier', 'error').inc();
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Mark shipment as delivered to customer (called when package is picked up)
app.post("/api/shipments/:resi/delivered-customer", async (req, res) => {
  try {
    const { resi } = req.params;

    const shipment = await Shipment.findOne({ resi });

    if (!shipment) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    // Delete the shipment from database (auto-delete when picked up)
    await Shipment.deleteOne({ resi });
    console.log(`[AUTO-DELETE] Shipment deleted: ${resi}`);

    // Delete the customer tracking record too
    await CustomerTracking.deleteOne({ resi });
    console.log(`[AUTO-DELETE] Customer tracking deleted: ${resi}`);

    // Remove resi from pendingResi locker
    await Locker.updateOne(
      { lockerId: shipment.lockerId },
      { $pull: { pendingResi: resi } }
    );

    // Recalculate state kurir yang mengantar shipment ini
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    res.json({ 
      ok: true, 
      message: "Package delivered and records cleaned up",
      deletedResi: resi 
    });
  } catch (err) {
    console.error("POST /api/shipments/:resi/delivered-customer error:", err);
    res.status(500).json({ error: "Failed to mark delivered" });
  }
});

// ESP32 loadcell notification - auto delete when package removed
app.post("/api/locker/:lockerId/package-removed", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { weight } = req.body; // Current weight from loadcell

    console.log(`[LOADCELL] ${lockerId} - Weight: ${weight}g - Checking for removed packages...`);

    // Find locker
    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    // Find all shipments in this locker that are ready for pickup
    const shipments = await Shipment.find({
      lockerId: lockerId,
      status: { $in: ['delivered_to_locker', 'ready_for_pickup'] }
    });

    if (shipments.length === 0) {
      return res.json({ 
        ok: true, 
        message: "No packages in locker to check",
        removed: 0 
      });
    }

    // If weight is low/zero, assume all packages were removed
    // Now using kilograms, not grams
    const weightThreshold = 1; // kilograms - less than 1kg means empty
    let removedCount = 0;

    if (weight < weightThreshold) {
      console.log(`[LOADCELL] Weight below threshold (${weight}kg < ${weightThreshold}kg) - Removing all packages`);
      
      for (const shipment of shipments) {
        // Delete shipment
        await Shipment.deleteOne({ resi: shipment.resi });
        
        // Delete customer tracking
        await CustomerTracking.deleteOne({ resi: shipment.resi });
        
        // Remove from locker's pendingResi
        await Locker.updateOne(
          { lockerId: lockerId },
          { $pull: { pendingResi: shipment.resi } }
        );

        // Recalculate courier state
        if (shipment.courierId) {
          await recalcCourierState(shipment.courierId);
        }

        console.log(`[AUTO-DELETE] Package removed by customer: ${shipment.resi}`);
        removedCount++;
      }
    }

    res.json({ 
      ok: true, 
      message: `${removedCount} package(s) auto-deleted`,
      removed: removedCount,
      currentWeight: weight 
    });

  } catch (err) {
    console.error("POST /api/locker/:lockerId/package-removed error:", err);
    res.status(500).json({ error: "Failed to process package removal" });
  }
});

// Kurir scan locker (QR code scan validation)
app.post("/api/scan", async (req, res) => {
  try {
    const { courierId, lockerId, token, resi } = req.body;

    if (!courierId || ! lockerId || !token) {
      return res.status(400).json({ error: "courierId, lockerId, dan token wajib diisi" });
    }

    const courier = await Courier.findOne({ courierId });
    if (! courier) {
      return res. status(404).json({ error: "Courier not found" });
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
    res.status(500). json({ error: "Scan failed" });
  }
});

// ---------------------- LOCKER LIST / POOL ----------------------

// POST: Register a new locker client (form submission) - Requires Auth
app.post("/api/lockers/register", auth, async (req, res) => {
  try {
    const { lockerId, nama, alamat, phoneNumber } = req.body;
    const customerId = req.user.userId; // From JWT token

    // Validation
    if (!lockerId || !nama || !alamat || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: "Semua field wajib diisi (lockerId, nama, alamat, phoneNumber)"
      });
    }

    // Check if locker ID already exists
    const existingLocker = await Locker.findOne({ lockerId });
    if (existingLocker) {
      return res.status(409).json({
        success: false,
        error: `Locker dengan ID '${lockerId}' sudah terdaftar`
      });
    }

    // Generate token for the new locker
    const lockerToken = randomToken(`LK-${lockerId}`);

    // Create new locker linked to customer account
    const newLocker = await Locker.create({
      lockerId,
      lockerToken,
      customerId, // Link to customer account
      ownerName: nama,
      ownerAddress: alamat,
      ownerPhone: phoneNumber,
      pendingResi: [],
      courierHistory: [],
      command: null,
      isActive: true,
      status: "unknown",
      tokenUpdatedAt: new Date(),
    });

    console.log(`[REGISTER] New locker registered: ${lockerId} - Owner: ${nama} - Customer: ${customerId}`);

    res.status(201).json({
      success: true,
      message: "Locker berhasil didaftarkan ke akun Anda",
      data: {
        lockerId: newLocker.lockerId,
        lockerToken: newLocker.lockerToken,
        customerId: newLocker.customerId,
        ownerName: newLocker.ownerName,
        ownerAddress: newLocker.ownerAddress,
        ownerPhone: newLocker.ownerPhone,
        status: newLocker.status,
        createdAt: newLocker.tokenUpdatedAt
      }
    });
  } catch (err) {
    console.error("POST /api/lockers/register error:", err);
    
    // Handle duplicate key error
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "Locker ID sudah terdaftar"
      });
    }
    
    res.status(500).json({
      success: false,
      error: "Gagal mendaftarkan locker"
    });
  }
});

// GET: Get all lockers belonging to the logged-in customer
app.get("/api/customer/lockers", auth, async (req, res) => {
  try {
    const customerId = req.user.userId;
    
    const lockers = await Locker.find({ customerId });
    console.log(`[DEBUG] GET /api/customer/lockers - Found ${lockers.length} lockers for customer ${customerId}`);

    // Calculate status for each locker
    const now = new Date();
    const updatedLockers = lockers.map(locker => {
      let status = "unknown";
      if (locker.lastHeartbeat) {
        const diff = now - new Date(locker.lastHeartbeat);
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

    res.json({
      success: true,
      count: updatedLockers.length,
      lockers: updatedLockers
    });
  } catch (err) {
    console.error("GET /api/customer/lockers error:", err);
    res.status(500).json({ 
      success: false,
      error: "Gagal mengambil data locker" 
    });
  }
});

// GET semua locker (untuk Agent Locker Client Pool)
app.get("/api/lockers", async (req, res) => {
  try {
    const lockers = await Locker.find();
    console.log(`[DEBUG] GET /api/lockers - Found ${lockers.length} lockers`);

    // Status calculation logic
    const now = new Date();
    const updatedLockers = await Promise.all(lockers.map(async (locker) => {
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

      // Fetch ALL customer information from active shipments in this locker (MULTI-USER SUPPORT)
      let customerInfo = {
        name: '-',
        address: '-',
        phone: '-'
      };

      // Count total deliveries (pending/active shipments)
      let deliveriesCount = 0;

      // Try to find ALL active shipments in this locker
      const activeShipments = await Shipment.find({
        lockerId: locker.lockerId,
        status: { $in: ['assigned_to_locker', 'pending_locker', 'delivered_to_locker'] }
      }).sort({ deliveredToLockerAt: -1 });

      deliveriesCount = activeShipments.length;

      if (activeShipments.length > 0) {
        // Get unique customers (maintain consistent order by sorting)
        const uniqueCustomerIds = [...new Set(activeShipments.map(s => s.customerId).filter(Boolean))].sort();
        
        if (uniqueCustomerIds.length === 1) {
          // Single customer - show their info
          const activeShipment = activeShipments[0];
          const customer = await User.findOne({ userId: activeShipment.customerId });
          if (customer) {
            customerInfo = {
              name: customer.name || activeShipment.receiverName || '-',
              address: customer.address || '-',
              phone: customer.phone || activeShipment.receiverPhone || '-'
            };
          } else {
            customerInfo = {
              name: activeShipment.receiverName || '-',
              address: '-',
              phone: activeShipment.receiverPhone || '-'
            };
          }
        } else if (uniqueCustomerIds.length > 1) {
          // Multiple customers - fetch all customer data first to maintain order
          const customersData = [];
          
          for (const customerId of uniqueCustomerIds) {
            const customer = await User.findOne({ userId: customerId });
            if (customer) {
              customersData.push({
                name: customer.name || '-',
                address: customer.address || '-',
                phone: customer.phone || '-'
              });
            } else {
              // Fallback to shipment receiver info
              const shipment = activeShipments.find(s => s.customerId === customerId);
              if (shipment) {
                customersData.push({
                  name: shipment.receiverName || '-',
                  address: '-',
                  phone: shipment.receiverPhone || '-'
                });
              }
            }
          }
          
          customerInfo = {
            name: customersData.map(c => c.name).join(', ') || '-',
            address: customersData.map(c => c.address).join(', ') || '-',
            phone: customersData.map(c => c.phone).join(', ') || '-'
          };
        } else {
          // No customerId but has shipments - use first shipment receiver info
          const activeShipment = activeShipments[0];
          customerInfo = {
            name: activeShipment.receiverName || '-',
            address: '-',
            phone: activeShipment.receiverPhone || '-'
          };
        }
      } else if (locker.customerId) {
        // No active shipment, try locker owner
        const customer = await User.findOne({ userId: locker.customerId });
        if (customer) {
          customerInfo = {
            name: customer.name || locker.ownerName || '-',
            address: customer.address || locker.ownerAddress || '-',
            phone: customer.phone || locker.ownerPhone || '-'
          };
        }
      } else {
        // Fallback to registration owner info
        customerInfo = {
          name: locker.ownerName || '-',
          address: locker.ownerAddress || '-',
          phone: locker.ownerPhone || '-'
        };
      }

      return {
        ... locker. toObject(),
        status,
        customerInfo,
        deliveries: deliveriesCount // Add delivery count
      };
    }));

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
    console. error("GET /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// NEW: Get courier history for a locker
app.get("/api/lockers/:lockerId/courier-history", async (req, res) => {
  try {
    const { lockerId } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();

    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    res.json({
      lockerId: locker. lockerId,
      currentToken: locker.lockerToken,
      tokenUpdatedAt: locker.tokenUpdatedAt,
      courierHistory: locker.courierHistory || [],
    });
  } catch (err) {
    console.error("GET /api/lockers/:lockerId/courier-history error:", err);
    res. status(500).json({ error: "Internal server error" });
  }
});

// SANITASI: hapus locker
app.delete("/api/lockers/:lockerId", async (req, res) => {
  try {
    await Locker.deleteOne({ lockerId: req.params.lockerId });
    res.json({ ok: true });
  } catch (err) {
    console. error("DELETE /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------- ESP32 & Locker Command ----------------------

// Ambil token locker (QR) untuk ESP32 + HEARTBEAT
app.get("/api/locker/:lockerId/token", async (req, res) => {
  const { lockerId } = req.params;

  try {
    let locker = await Locker. findOne({ lockerId });

    if (!locker) {
      locker = await Locker.create({
        lockerId,
        lockerToken: randomToken("LK-" + lockerId),
        isActive: true,
        status: "offline",
        courierHistory: [],
      });
    }

    const now = new Date();

    // update heartbeat + status
    locker.lastHeartbeat = now;
    locker.status = "online";
    await locker.save();

    console.log(`[HEARTBEAT] Locker ${lockerId} token: ${locker.lockerToken}`);

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

    if (!token || ! resi) {
      return res.status(400).json({ error: "token dan resi wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    if (token !== locker.lockerToken) {
      return res.status(403).json({ error: "Token locker tidak valid" });
    }

    if (! locker.pendingResi.includes(resi)) {
      return res.status(403).json({
        error: "Resi tidak terdaftar untuk locker ini atau sudah diproses",
        pendingResi: locker.pendingResi,
      });
    }

    const shipment = await Shipment.findOne({ resi });
    if (!shipment) {
      return res.status(404).json({ error: "Shipment/resi tidak ditemukan" });
    }

    // ✅ Update courier activity
    await updateCourierActivity(shipment.courierId);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "locker_deposit_legacy" },
    });
    await shipment.save();

    // 🔹 STORE COURIER HISTORY
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory.push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: token,
    });

    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);
    locker.command = {
      type: "open",
      resi,
      source: "courier",
      createdAt: new Date(),
    };

    // 🔹 ROTATE TOKEN
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[TOKEN ROTATE] ${lockerId}: ${oldToken} → ${locker.lockerToken}`);

    return res.json({
      message: "Locker akan dibuka untuk resi ini, token telah dirotasi",
      lockerId,
      resi,
      remainingPendingResi: locker.pendingResi,
      oldToken,
      newToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 polling command (open, dsb.)
app.get("/api/locker/:lockerId/command", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await getLocker(lockerId);

    if (!locker. command) {
      return res. json({ command: "none" });
    }

    const cmd = locker.command;

    // 🔍 DEBUG: catat kapan ESP32 menarik command (polling)
    if (locker.debugInfo?.enabled) {
      pushDebugPhase(locker, "command", { resi: cmd.resi });

      // Hitung durasi dari scan (backend) ke command diambil ESP
      if (locker.debugInfo.scanAtBackend) {
        const diffMs =
          new Date() - new Date(locker.debugInfo.scanAtBackend);
        console.log(
          `[DEBUG-QR] Δ scan(backend) → command(ESP poll) = ${diffMs} ms (locker=${lockerId}, resi=${cmd.resi})`
        );
      }
    }

    locker.command = null; // one-shot
    await locker.save();

    console.log(`[COMMAND] Sent to ${lockerId}: ${cmd.type}`);

    return res.json({
      command: cmd.type,
      resi: cmd.resi,
      source: cmd.source,
      createdAt: cmd.createdAt,
    });
  } catch (err) {
    console. error("GET /api/locker/:lockerId/command error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 heartbeat - dipanggil berkala oleh ESP32
app.post("/api/locker/:lockerId/heartbeat", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404). json({ error: "Locker not found" });
    }
    locker.status = "online";
    locker.lastHeartbeat = new Date();
    await locker. save();
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

    // 🔍 DEBUG: kalau event dari ESP adalah buka loker, hitung total waktu
    if (["locker_opened", "opened_by_courier"].includes(event)) {
      const locker = await Locker.findOne({ lockerId });

      if (locker?.debugInfo?.enabled && locker.debugInfo.scanAtBackend) {
        pushDebugPhase(locker, "esp_log", { resi });

        const tScanBackend = new Date(locker.debugInfo.scanAtBackend);
        const tEspLog = logEntry.timestamp;

        const totalMs = tEspLog - tScanBackend;
        let clientPart = null;

        if (locker.debugInfo.scanAtClient) {
          clientPart = tScanBackend - new Date(locker.debugInfo.scanAtClient);
        }

        console.log(
          `[DEBUG-QR] FINAL locker=${lockerId} resi=${resi} ` +
            `(scanBackend→espLog = ${totalMs} ms` +
            (clientPart != null ? `, scanClient→backend = ${clientPart} ms` : "") +
            `)`
        );

        await locker.save();
      }
    }

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

// Check resi + locker compatibility (troubleshooting endpoint)
app.get("/api/debug/check/:lockerId/:resi", async (req, res) => {
  try {
    const { lockerId, resi } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();
    const shipment = await Shipment.findOne({ resi }).lean();

    return res.json({
      lockerId,
      resi,
      locker: locker ? {
        lockerId: locker.lockerId,
        lockerToken: locker.lockerToken,
        pendingResi: locker.pendingResi,
        isResiInPending: locker.pendingResi?.includes(resi) || false,
      } : null,
      shipment: shipment ? {
        resi: shipment.resi,
        lockerId: shipment.lockerId,
        status: shipment.status,
        courierId: shipment.courierId,
        courierPlate: shipment.courierPlate,
        courierName: shipment.courierName,
      } : null,
      analysis: {
        lockerExists: !!locker,
        shipmentExists: !!shipment,
        lockerMatches: shipment?.lockerId === lockerId,
        resiInPending: locker?.pendingResi?.includes(resi) || false,
        canDeposit: !!shipment && !!locker && shipment.lockerId === lockerId && shipment.status === "pending_locker",
        statusReason: !shipment ? "Shipment not found" :
                      !locker ? "Locker not found" :
                      shipment.lockerId !== lockerId ? `Wrong locker (expected ${shipment.lockerId})` :
                      shipment.status !== "pending_locker" ? `Wrong status (${shipment.status})` : "OK",
      },
    });
  } catch (err) {
    console.error("GET /api/debug/check error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get all pending shipments for a locker
app.get("/api/debug/locker/:lockerId/pending", async (req, res) => {
  try {
    const { lockerId } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();
    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    const pendingShipments = await Shipment.find({
      lockerId,
      status: "pending_locker",
    }).lean();

    return res.json({
      lockerId,
      lockerToken: locker.lockerToken,
      pendingResiInLocker: locker.pendingResi || [],
      pendingShipments: pendingShipments.map(s => ({
        resi: s.resi,
        courierPlate: s.courierPlate,
        courierName: s.courierName,
        courierId: s.courierId,
        customerId: s.customerId,
        status: s.status,
        createdAt: s.createdAt,
      })),
      count: pendingShipments.length,
      mismatch: locker.pendingResi.filter(resi =>
        !pendingShipments.some(s => s.resi === resi)
      ),
    });
  } catch (err) {
    console.error("GET /api/debug/locker/:lockerId/pending error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== GET UNIQUE CUSTOMERS FROM customer_trackings ====================

// ✨ FIX TYPO: Update shipment locker name
app.post("/api/debug/fix-locker-name", async (req, res) => {
  try {
    const { resi, oldLockerId, newLockerId } = req.body;

    if (!resi || !oldLockerId || !newLockerId) {
      return res.status(400).json({
        error: "resi, oldLockerId, dan newLockerId wajib diisi"
      });
    }

    const shipment = await Shipment.findOne({ resi, lockerId: oldLockerId });

    if (!shipment) {
      return res.status(404).json({
        error: `Shipment dengan resi ${resi} di locker ${oldLockerId} tidak ditemukan`
      });
    }

    const oldLocker = await Locker.findOne({ lockerId: oldLockerId });
    const newLocker = await Locker.findOne({ lockerId: newLockerId });

    // Update shipment
    shipment.lockerId = newLockerId;
    await shipment.save();

    // Update old locker pendingResi
    if (oldLocker) {
      oldLocker.pendingResi = oldLocker.pendingResi.filter(r => r !== resi);
      await oldLocker.save();
    }

    // Update new locker pendingResi
    if (newLocker) {
      if (!newLocker.pendingResi.includes(resi)) {
        newLocker.pendingResi.push(resi);
        await newLocker.save();
      }
    }

    console.log(`[FIX] Moved shipment ${resi} from ${oldLockerId} to ${newLockerId}`);

    return res.json({
      ok: true,
      message: `Shipment ${resi} dipindahkan dari ${oldLockerId} ke ${newLockerId}`,
      shipment: {
        resi: shipment.resi,
        oldLockerId,
        newLockerId,
        status: shipment.status,
      }
    });
  } catch (err) {
    console.error("POST /api/debug/fix-locker-name error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ✨ AUTO-FIX: Fix locker name by courier plate
app.post("/api/debug/fix-by-plate", async (req, res) => {
  try {
    const { plate, correctLockerId } = req.body;

    if (!plate || !correctLockerId) {
      return res.status(400).json({
        error: "plate dan correctLockerId wajib diisi"
      });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    // Find pending shipment with this plate
    const shipment = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
    });

    if (!shipment) {
      return res.status(404).json({
        error: `Tidak ada shipment pending untuk plat ${normalizedPlate}`
      });
    }

    const oldLockerId = shipment.lockerId;

    if (oldLockerId === correctLockerId) {
      return res.json({
        ok: true,
        message: "Locker ID sudah benar, tidak perlu diperbaiki",
        shipment: {
          resi: shipment.resi,
          lockerId: shipment.lockerId,
        }
      });
    }

    // Update shipment
    shipment.lockerId = correctLockerId;
    await shipment.save();

    // Update old locker
    const oldLocker = await Locker.findOne({ lockerId: oldLockerId });
    if (oldLocker) {
      oldLocker.pendingResi = oldLocker.pendingResi.filter(r => r !== shipment.resi);
      await oldLocker.save();
    }

    // Update new locker
    const newLocker = await Locker.findOne({ lockerId: correctLockerId });
    if (newLocker) {
      if (!newLocker.pendingResi.includes(shipment.resi)) {
        newLocker.pendingResi.push(shipment.resi);
        await newLocker.save();
      }
    }

    console.log(`[AUTO-FIX] Moved shipment ${shipment.resi} from ${oldLockerId} to ${correctLockerId} (plate: ${normalizedPlate})`);

    return res.json({
      ok: true,
      message: `Shipment untuk plat ${normalizedPlate} dipindahkan dari ${oldLockerId} ke ${correctLockerId}`,
      fixed: {
        resi: shipment.resi,
        plate: normalizedPlate,
        oldLockerId,
        newLockerId: correctLockerId,
      }
    });
  } catch (err) {
    console.error("POST /api/debug/fix-by-plate error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Check all pending shipments in system
app.get("/api/debug/all-pending", async (req, res) => {
  try {
    const pendingShipments = await Shipment.find({
      status: "pending_locker"
    }).sort({ createdAt: -1 }).limit(50).lean();

    return res.json({
      ok: true,
      count: pendingShipments.length,
      shipments: pendingShipments.map(s => ({
        resi: s.resi,
        lockerId: s.lockerId,
        courierPlate: s.courierPlate || 'NOT SET',
        courierName: s.courierName || 'NOT SET',
        courierId: s.courierId || 'NOT SET',
        customerId: s.customerId,
        createdAt: s.createdAt,
      }))
    });
  } catch (err) {
    console.error("GET /api/debug/all-pending error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== GET UNIQUE CUSTOMERS FROM customer_trackings ====================

// Get list of unique customers from customer_trackings collection
app.get("/api/customers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "500", 10);

    // Get all customer trackings
    const trackings = await CustomerTracking.find({
      customerId: { $exists: true, $ne: null, $ne: "" },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Extract unique customers
    const customerMap = new Map();

    trackings.forEach(tracking => {
      const customerId = tracking.customerId?.trim();

      if (customerId) {
        if (!customerMap.has(customerId)) {
          customerMap.set(customerId, {
            customerId: customerId,
            name: 'Unknown', // Will be filled from User collection
            phone: '',
            lastUsed: tracking.createdAt,
            totalResi: 1,
            resiList: [tracking.resi],
          });
        } else {
          // Update existing customer
          const existing = customerMap.get(customerId);
          existing.totalResi += 1;
          existing.resiList.push(tracking.resi);

          if (new Date(tracking.createdAt) > new Date(existing.lastUsed)) {
            existing.lastUsed = tracking.createdAt;
          }
        }
      }
    });

    // Now fetch user details for each customer ID
    const customerIds = Array.from(customerMap.keys());
    const users = await User.find({
      userId: { $in: customerIds },
      role: "customer",
    })
      .select("userId name phone email")
      .lean();

    // Merge user data into customer map
    users.forEach(user => {
      if (customerMap.has(user.userId)) {
        const customer = customerMap.get(user.userId);
        customer.name = user.name || 'Unknown';
        customer.phone = user.phone || '';
        customer.email = user.email || '';
        customer.registered = true;
      }
    });

    // Convert to array and sort by most recent
    const customers = Array.from(customerMap.values())
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    console.log(`[API] Found ${customers.length} unique customers from customer_trackings`);
    console.log(`[API] ${users.length} customers are registered users`);

    res.json({
      ok: true,
      count: customers.length,
      data: customers,
      source: 'customer_trackings',
    });
  } catch (err) {
    console.error("GET /api/customers error:", err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// ==================== SEARCH CUSTOMERS (optional - for better UX) ====================

// Search customers by ID, name, or phone
app.get("/api/customers/search", async (req, res) => {
  try {
    const { q } = req.query; // search query

    if (!q || q.length < 2) {
      return res.json({ ok: true, data: [] });
    }

    const searchRegex = new RegExp(q, "i"); // case-insensitive

    // Search in shipments
    const shipments = await Shipment.find({
      $or: [
        { customerId: searchRegex },
        { receiverName: searchRegex },
        { receiverPhone: searchRegex },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Extract unique matches
    const customerMap = new Map();

    shipments.forEach(shipment => {
      const customerId = shipment.customerId?.trim();

      if (customerId && !customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customerId: customerId,
          name: shipment.receiverName || 'Unknown',
          phone: shipment.receiverPhone || '',
          lastUsed: shipment.createdAt,
          matchedField:
            shipment.customerId.match(searchRegex) ? 'id' :
            shipment.receiverName?.match(searchRegex) ? 'name' : 'phone',
        });
      }
    });

    const results = Array.from(customerMap.values())
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    console.log(`[SEARCH] Query: "${q}", found ${results.length} customers`);

    res.json({
      ok: true,
      query: q,
      count: results.length,
      data: results,
    });
  } catch (err) {
    console.error("GET /api/customers/search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ==================== GET REGISTERED CUSTOMERS (from User collection) ====================

// Get customers who registered via mobile app
app.get("/api/customers/registered", async (req, res) => {
  try {
    const users = await User.find({ role: "customer" })
      .select("userId name email phone createdAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Also get their shipment count
    const customersWithStats = await Promise.all(
      users.map(async (user) => {
        const shipmentCount = await Shipment.countDocuments({
          customerId: user.userId,
        });

        return {
          customerId: user.userId,
          name: user.name,
          phone: user.phone,
          email: user.email,
          registered: true,
          totalOrders: shipmentCount,
          lastUsed: user.createdAt,
        };
      })
    );

    res.json({
      ok: true,
      count: customersWithStats.length,
      data: customersWithStats,
    });
  } catch (err) {
    console.error("GET /api/customers/registered error:", err);
    res.status(500).json({ error: "Failed to fetch registered customers" });
  }
});

// ==================== CUSTOMER STATISTICS ====================

// Get detailed stats for a specific customer
app.get("/api/customers/:customerId/stats", async (req, res) => {
  try {
    const { customerId } = req.params;

    const shipments = await Shipment.find({ customerId })
      .sort({ createdAt: -1 })
      .lean();

    if (shipments.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const stats = {
      customerId,
      name: shipments[0].receiverName,
      phone: shipments[0].receiverPhone,
      totalOrders: shipments.length,
      pending: shipments.filter(s => s.status === 'pending_locker').length,
      delivered: shipments.filter(s => s.status === 'delivered_to_locker').length,
      completed: shipments.filter(s => s.status === 'completed').length,
      firstOrder: shipments[shipments.length - 1].createdAt,
      lastOrder: shipments[0].createdAt,
      recentShipments: shipments.slice(0, 5).map(s => ({
        resi: s.resi,
        status: s.status,
        lockerId: s.lockerId,
        createdAt: s.createdAt,
      })),
    };

    res.json({
      ok: true,
      data: stats,
    });
  } catch (err) {
    console.error("GET /api/customers/:customerId/stats error:", err);
    res.status(500).json({ error: "Failed to fetch customer stats" });
  }
});

// ==================================================
// CUSTOM METRICS ENDPOINT (for thesis data collection)
// ==================================================
app.get('/api/metrics/custom', async (req, res) => {
  try {
    res.set('Content-Type', customRegister.contentType);
    res.end(await customRegister.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
});

// Metrics summary endpoint (human-readable JSON)
app.get('/api/metrics/summary', async (req, res) => {
  try {
    const metrics = await customRegister.getMetricsAsJSON();
    
    // Calculate statistics
    const summary = {
      timestamp: new Date().toISOString(),
      endpoints: {},
      database: {},
      externalApis: {},
      system: {},
    };
    
    // Process metrics into readable format
    metrics.forEach(metric => {
      if (metric.name === 'http_request_duration_seconds') {
        metric.values.forEach(v => {
          const key = `${v.labels.method} ${v.labels.route}`;
          if (!summary.endpoints[key]) {
            summary.endpoints[key] = {
              count: 0,
              totalDuration: 0,
              avgDuration: 0,
              statusCodes: {},
            };
          }
          summary.endpoints[key].count += v.value;
          summary.endpoints[key].statusCodes[v.labels.status_code] = 
            (summary.endpoints[key].statusCodes[v.labels.status_code] || 0) + v.value;
        });
      }
    });
    
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================================================
// WEIGHT MEASUREMENT ENDPOINTS (ESP32) - DIFFERENTIAL ALGORITHM
// ==================================================

// In-memory weight session storage (per locker)
const weightSessions = new Map();

// Start weight measurement session (called after courier scan)
app.post("/api/locker/:lockerId/weight/start", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { resi } = req.body;

    console.log(`[WEIGHT SESSION] Starting for ${lockerId}, resi: ${resi}`);

    if (!resi) {
      return res.status(400).json({
        ok: false,
        error: "resi wajib diisi"
      });
    }

    // Initialize weight session
    const sessionId = `${lockerId}-${Date.now()}`;
    weightSessions.set(lockerId, {
      sessionId,
      resi: resi.trim().toUpperCase(),
      startedAt: new Date(),
      readings: [], // Store all weight readings
      active: true
    });

    console.log(`[WEIGHT SESSION] ✅ Started session ${sessionId} for resi ${resi}`);

    return res.json({
      ok: true,
      message: "Weight session started",
      sessionId,
      lockerId,
      resi: resi.trim().toUpperCase(),
      duration: "20 seconds"
    });

  } catch (err) {
    console.error("POST /api/locker/:lockerId/weight/start error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal memulai weight session"
    });
  }
});

// ESP32 sends weight readings (called every few seconds)
app.post("/api/locker/:lockerId/weight/reading", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { weight } = req.body; // weight in kilograms

    console.log(`[API IN] POST /api/locker/${lockerId}/weight/reading - Body:`, req.body);

    // Validate weight
    const weightValue = parseFloat(weight);
    if (isNaN(weightValue) || weightValue < 0 || weightValue > 50) {
      console.log(`[WEIGHT] ❌ Invalid weight: ${weight}`);
      return res.status(400).json({
        ok: false,
        error: "Weight value tidak valid (harus 0-50 kg)"
      });
    }

    // Check if session exists
    const session = weightSessions.get(lockerId);
    console.log(`[WEIGHT] Session check - lockerId: ${lockerId}, exists: ${!!session}, active: ${session?.active}`);
    
    if (!session || !session.active) {
      console.log(`[WEIGHT] ❌ No active session for ${lockerId}. Available sessions:`, Array.from(weightSessions.keys()));
      return res.status(404).json({
        ok: false,
        error: "No active weight session for this locker"
      });
    }

    // Add reading to session
    session.readings.push({
      weight: weightValue,
      timestamp: new Date()
    });

    console.log(`[WEIGHT READING] ${lockerId}: ${weightValue}kg (reading #${session.readings.length}) - RESI: ${session.resi}`);

    return res.json({
      ok: true,
      message: "Weight reading recorded",
      sessionId: session.sessionId,
      readingNumber: session.readings.length,
      weight: weightValue,
      resi: session.resi
    });

  } catch (err) {
    console.error("POST /api/locker/:lockerId/weight/reading error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal merekam weight reading"
    });
  }
});

// Finalize weight measurement (calculate difference and assign to resi)
app.post("/api/locker/:lockerId/weight/finalize", async (req, res) => {
  try {
    const { lockerId } = req.params;

    console.log(`[WEIGHT FINALIZE] Processing for ${lockerId}`);

    // Get session
    const session = weightSessions.get(lockerId);
    if (!session || !session.active) {
      return res.status(404).json({
        ok: false,
        error: "No active weight session for this locker"
      });
    }

    // Check if we have at least 2 readings
    if (session.readings.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Need at least 2 weight readings to calculate difference"
      });
    }

    // Calculate weight difference (initial - final = package weight)
    const initialWeight = session.readings[0].weight;
    const finalWeight = session.readings[session.readings.length - 1].weight;
    const packageWeight = parseFloat(Math.abs(initialWeight - finalWeight).toFixed(3));

    console.log(`[WEIGHT CALC] Initial: ${initialWeight}kg, Final: ${finalWeight}kg, Difference: ${packageWeight}kg`);

    // Find the shipment
    const shipment = await Shipment.findOne({ resi: session.resi });

    if (!shipment) {
      console.error(`[WEIGHT] Shipment not found for resi: ${session.resi}`);
      // Mark session as inactive
      session.active = false;
      return res.status(404).json({
        ok: false,
        error: "Shipment tidak ditemukan untuk resi ini"
      });
    }

    // Check if weight already recorded
    if (shipment.weight !== null && shipment.weight !== undefined) {
      console.log(`[WEIGHT] Weight already recorded for ${session.resi}: ${shipment.weight}kg`);
      session.active = false;
      return res.json({
        ok: true,
        message: "Weight sudah tercatat sebelumnya",
        data: {
          resi: shipment.resi,
          weight: shipment.weight,
          weightRecordedAt: shipment.weightRecordedAt,
          alreadyRecorded: true
        }
      });
    }

    // Assign weight to shipment
    shipment.weight = packageWeight;
    shipment.weightRecordedAt = new Date();

    // Add log entry with all readings
    shipment.logs.push({
      event: "weight_recorded_differential",
      lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
      extra: {
        initialWeight,
        finalWeight,
        packageWeight,
        readingsCount: session.readings.length,
        unit: "kilograms"
      }
    });

    await shipment.save();

    console.log(`[WEIGHT] ✅ Assigned ${packageWeight}kg to resi ${session.resi}`);

    // Send notification to customer
    try {
      if (shipment.customerId) {
        await sendNotificationToCustomer(
          shipment.customerId,
          '📦 Paket Sudah di Locker',
          `Paket ${session.resi} telah diterima (${packageWeight.toFixed(2)} kg)`,
          {
            type: 'weight_recorded',
            resi: shipment.resi,
            weight: packageWeight,
            lockerId: lockerId
          }
        );
      }
    } catch (notifErr) {
      console.error('[WEIGHT NOTIFICATION] Failed:', notifErr.message);
    }

    // Mark session as inactive
    session.active = false;

    return res.json({
      ok: true,
      message: "Weight berhasil direkam",
      data: {
        resi: shipment.resi,
        weight: packageWeight,
        unit: "kg",
        weightRecordedAt: shipment.weightRecordedAt,
        lockerId: lockerId,
        calculation: {
          initialWeight,
          finalWeight,
          difference: packageWeight,
          readingsCount: session.readings.length
        }
      }
    });

  } catch (err) {
    console.error("POST /api/locker/:lockerId/weight/finalize error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal finalize weight measurement"
    });
  }
});

// Get current weight session status (for monitoring)
app.get("/api/locker/:lockerId/weight/status", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const session = weightSessions.get(lockerId);

    if (!session) {
      return res.json({
        ok: true,
        hasSession: false,
        message: "No weight session for this locker"
      });
    }

    return res.json({
      ok: true,
      hasSession: true,
      session: {
        sessionId: session.sessionId,
        resi: session.resi,
        startedAt: session.startedAt,
        active: session.active,
        readingsCount: session.readings.length,
        latestWeight: session.readings.length > 0 
          ? session.readings[session.readings.length - 1].weight 
          : null
      }
    });

  } catch (err) {
    console.error("GET /api/locker/:lockerId/weight/status error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal mengambil status weight session"
    });
  }
});

// Get weight data for a specific resi
app.get("/api/shipments/:resi/weight", async (req, res) => {
  try {
    const { resi } = req.params;
    const cleanResi = resi.trim().toUpperCase();

    const shipment = await Shipment.findOne({ resi: cleanResi }).lean();

    if (!shipment) {
      return res.status(404).json({
        ok: false,
        error: "Shipment tidak ditemukan"
      });
    }

    return res.json({
      ok: true,
      data: {
        resi: shipment.resi,
        weight: shipment.weight,
        unit: "kg",
        weightRecordedAt: shipment.weightRecordedAt,
        hasWeight: shipment.weight !== null && shipment.weight !== undefined,
        status: shipment.status
      }
    });

  } catch (err) {
    console.error("GET /api/shipments/:resi/weight error:", err);
    return res.status(500).json({
      ok: false,
      error: "Gagal mengambil data weight"
    });
  }
});

// ==================================================
// TESTING ENDPOINT - Simulate entire weight measurement flow
// ==================================================
app.post("/api/test/weight-simulation", async (req, res) => {
  try {
    const { lockerId, resi } = req.body;

    if (!lockerId || !resi) {
      return res.status(400).json({
        ok: false,
        error: "lockerId and resi required"
      });
    }

    console.log(`\n========================================`);
    console.log(`[TEST] Starting weight simulation for ${lockerId}, resi: ${resi}`);
    console.log(`========================================\n`);

    const results = {
      step1_start: null,
      step2_readings: [],
      step3_finalize: null,
      step4_verify: null
    };

    // STEP 1: Start weight session
    try {
      const startRes = await axios.post(`http://localhost:${PORT}/api/locker/${lockerId}/weight/start`, {
        resi: resi
      });
      results.step1_start = startRes.data;
      console.log(`[TEST] ✅ Step 1 - Session started:`, startRes.data);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "Failed to start session",
        detail: err.response?.data || err.message
      });
    }

    // STEP 2: Simulate weight readings (5 readings over 20 seconds)
    // Simulating: 5kg → 4.8kg → 4.6kg → 4.5kg → 4.3kg (package removed = ~0.7kg)
    const simulatedWeights = [5.0, 4.8, 4.6, 4.5, 4.3];
    
    for (let i = 0; i < simulatedWeights.length; i++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between readings
        
        const readingRes = await axios.post(`http://localhost:${PORT}/api/locker/${lockerId}/weight/reading`, {
          weight: simulatedWeights[i]
        });
        
        results.step2_readings.push(readingRes.data);
        console.log(`[TEST] ✅ Step 2.${i+1} - Reading recorded: ${simulatedWeights[i]}kg`);
      } catch (err) {
        console.error(`[TEST] ❌ Failed to send reading ${i+1}:`, err.message);
      }
    }

    // STEP 3: Finalize measurement
    try {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      
      const finalizeRes = await axios.post(`http://localhost:${PORT}/api/locker/${lockerId}/weight/finalize`);
      results.step3_finalize = finalizeRes.data;
      console.log(`[TEST] ✅ Step 3 - Finalized:`, finalizeRes.data);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "Failed to finalize",
        detail: err.response?.data || err.message,
        partialResults: results
      });
    }

    // STEP 4: Verify weight was saved
    try {
      const verifyRes = await axios.get(`http://localhost:${PORT}/api/shipments/${resi}/weight`);
      results.step4_verify = verifyRes.data;
      console.log(`[TEST] ✅ Step 4 - Verified:`, verifyRes.data);
    } catch (err) {
      console.error(`[TEST] ⚠️ Failed to verify:`, err.message);
    }

    console.log(`\n========================================`);
    console.log(`[TEST] ✅ SIMULATION COMPLETE`);
    console.log(`========================================\n`);

    return res.json({
      ok: true,
      message: "Weight simulation completed successfully",
      summary: {
        lockerId,
        resi,
        initialWeight: simulatedWeights[0],
        finalWeight: simulatedWeights[simulatedWeights.length - 1],
        calculatedDifference: simulatedWeights[0] - simulatedWeights[simulatedWeights.length - 1],
        recordedWeight: results.step3_finalize?.data?.weight || null
      },
      detailedResults: results
    });

  } catch (err) {
    console.error("[TEST] Weight simulation error:", err);
    return res.status(500).json({
      ok: false,
      error: "Simulation failed",
      detail: err.message
    });
  }
});

// ==================================================
// TESTING ENDPOINT - Manually set weight for shipment (for testing UI)
// ==================================================
app.post("/api/test/set-weight", async (req, res) => {
  try {
    const { resi, weight } = req.body;

    if (!resi || !weight) {
      return res.status(400).json({
        ok: false,
        error: "resi and weight required"
      });
    }

    const cleanResi = resi.trim().toUpperCase();
    const weightKg = parseFloat(weight);

    if (isNaN(weightKg) || weightKg <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid weight value"
      });
    }

    const shipment = await Shipment.findOne({ resi: cleanResi });

    if (!shipment) {
      return res.status(404).json({
        ok: false,
        error: "Shipment not found"
      });
    }

    shipment.weight = parseFloat(weightKg.toFixed(3));
    shipment.weightRecordedAt = new Date();

    // Add log entry
    shipment.logs.push({
      event: "weight_recorded",
      lockerId: shipment.lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
      extra: {
        weight: weightKg,
        source: "manual_test"
      }
    });

    await shipment.save();

    console.log(`[TEST] ✅ Manually set weight ${weightKg}kg for resi ${cleanResi}`);

    return res.json({
      ok: true,
      message: "Weight successfully set",
      data: {
        resi: shipment.resi,
        weight: shipment.weight,
        weightKg: shipment.weight.toFixed(2),
        unit: "kg",
        weightRecordedAt: shipment.weightRecordedAt
      }
    });

  } catch (err) {
    console.error("[TEST] Set weight error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to set weight",
      detail: err.message
    });
  }
});

// ==================================================
// START SERVER
// ==================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Locker backend running at http://localhost:${PORT}`);
  console.log(`Prometheus metrics available at http://localhost:${PORT}/metrics`);
  console.log(`Custom metrics (Prometheus format): http://localhost:${PORT}/api/metrics/custom`);
  console.log(`Metrics summary (JSON): http://localhost:${PORT}/api/metrics/summary`);
});