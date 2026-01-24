# Weight & Tracking Display Fix

## Issues Fixed

### 1. Weight Not Displayed ❌ → ✅
**Problem:** Weight shows "Belum tercatat" (not recorded) even though shipment exists

**Root Cause:** 
- Weight parameter not being sent by courier app/ESP32 during deposit
- Backend was ready to accept weight but wasn't receiving it

**Solution:**
- ✅ Backend already has weight handling in deposit endpoint
- ✅ Weight must be sent as `weight` parameter in kg (e.g., `0.5`, `1.25`, `2.0`)
- ✅ Added test endpoint to manually set weight for testing

### 2. Tracking Not Showing ❌ → ✅
**Problem:** Tracking shows "Belum tersedia" (not available)

**Solution:**
- ✅ Created new enhanced endpoint: `GET /api/customer/shipments/:resi`
- ✅ Returns formatted tracking history from logs
- ✅ Includes weight information with proper formatting
- ✅ Provides human-readable status labels

---

## New/Updated API Endpoints

### 1. Get Customer Shipments (Enhanced)
**GET** `/api/customer/shipments`
- Headers: `Authorization: Bearer <token>`
- Returns list with weight info and tracking availability

**Response:**
```json
{
  "data": [
    {
      "resi": "TG7007260622",
      "status": "delivered_to_locker",
      "weight": 1.5,
      "weightRecordedAt": "2026-01-21T...",
      "weightInfo": {
        "weight": 1.5,
        "weightKg": "1.50",
        "unit": "kg",
        "recorded": true,
        "recordedAt": "2026-01-21T..."
      },
      "trackingAvailable": true,
      ...
    }
  ]
}
```

### 2. Get Single Shipment Details (NEW)
**GET** `/api/customer/shipments/:resi`
- Headers: `Authorization: Bearer <token>`
- Returns complete shipment info with tracking history

**Response:**
```json
{
  "ok": true,
  "data": {
    "resi": "TG7007260622",
    "courierType": "jne",
    "lockerId": "tesutoxx",
    "lockerInfo": {
      "lockerId": "tesutoxx",
      "ownerName": "Customer Name",
      "ownerAddress": "Address...",
      "status": "online"
    },
    "status": "delivered_to_locker",
    "statusLabel": "Siap diambil",
    "weight": {
      "value": 1.5,
      "formatted": "1.50 kg",
      "recorded": true,
      "recordedAt": "2026-01-21T..."
    },
    "tracking": {
      "available": true,
      "count": 5,
      "history": [
        {
          "event": "delivered_to_locker",
          "timestamp": "2026-01-21T...",
          "description": "Paket diterima di locker",
          "details": {...}
        },
        {
          "event": "weight_recorded",
          "timestamp": "2026-01-21T...",
          "description": "Berat paket tercatat (1.5 kg)",
          "details": {...}
        },
        ...
      ]
    },
    "dates": {
      "created": "2026-01-20T...",
      "deliveredToLocker": "2026-01-21T...",
      "deliveredToCustomer": null,
      "pickedUp": null
    },
    "receiver": {
      "name": "Customer Name",
      "phone": "08123456789"
    },
    "courier": {
      "name": "Courier Name",
      "plate": "B1234XYZ",
      "type": "jne"
    }
  }
}
```

### 3. Test: Manually Set Weight (NEW)
**POST** `/api/test/set-weight`

Use this to add weight to existing shipments for testing:

```bash
# PowerShell
Invoke-WebRequest -Uri "http://192.168.0.56:3000/api/test/set-weight" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"resi":"TG7007260622","weight":1.5}'
```

**Request:**
```json
{
  "resi": "TG7007260622",
  "weight": 1.5
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Weight successfully set",
  "data": {
    "resi": "TG7007260622",
    "weight": 1.5,
    "weightKg": "1.50",
    "unit": "kg",
    "weightRecordedAt": "2026-01-21T..."
  }
}
```

---

## Testing Steps

### 1. Add Weight to Your Shipment
```bash
# Add 1.5 kg weight to TG7007260622
Invoke-WebRequest -Uri "http://192.168.0.56:3000/api/test/set-weight" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"resi":"TG7007260622","weight":1.5}'
```

### 2. Get Shipment Details
```bash
# Get details with tracking and weight
Invoke-WebRequest -Uri "http://192.168.0.56:3000/api/customer/shipments/TG7007260622" `
  -Method Get `
  -Headers @{Authorization="Bearer YOUR_TOKEN_HERE"}
```

### 3. Test in Mobile App
1. **Refresh the delivery status page** - should now show weight
2. **Open shipment details** - should show tracking history
3. **Weight display** - should show "1.50 kg" instead of "Belum tercatat"

---

## Mobile App Integration

### Update Your Flutter/React Native Code

**For Delivery List:**
```dart
// Use enhanced endpoint
final response = await http.get(
  Uri.parse('$baseUrl/api/customer/shipments'),
  headers: {'Authorization': 'Bearer $token'}
);

// Access weight info
final weightInfo = shipment['weightInfo'];
final weightText = weightInfo['recorded'] 
  ? '${weightInfo['weightKg']} ${weightInfo['unit']}'
  : 'Belum tercatat';
```

**For Shipment Detail with Tracking:**
```dart
// Use new detail endpoint
final response = await http.get(
  Uri.parse('$baseUrl/api/customer/shipments/$resi'),
  headers: {'Authorization': 'Bearer $token'}
);

final data = response['data'];

// Display weight
final weight = data['weight'];
Text(weight['formatted']); // "1.50 kg"

// Display tracking
final tracking = data['tracking'];
if (tracking['available']) {
  ListView.builder(
    itemCount: tracking['count'],
    itemBuilder: (context, index) {
      final log = tracking['history'][index];
      return ListTile(
        title: Text(log['description']),
        subtitle: Text(formatDate(log['timestamp'])),
      );
    },
  );
} else {
  Text('Belum tersedia');
}
```

---

## How Weight System Works

### Courier App Flow:
1. Courier scans QR code at locker
2. **Must send weight parameter** in deposit request:
   ```json
   POST /api/courier/deposit-token
   {
     "lockerId": "tesutoxx",
     "lockerToken": "LK-...",
     "resi": "TG7007260622",
     "weight": 1.5    ← IN KILOGRAMS
   }
   ```
3. Backend stores weight with 3 decimal precision
4. Customer app displays weight

### Weight Sensor (Load Cell) Integration:
If using ESP32 with load cell:
```cpp
// ESP32 code should send weight in kg
float weightKg = scale.get_units(10) / 1000.0; // Convert grams to kg

// Send to backend
http.POST("/api/locker/" + lockerId + "/weight/reading", 
  "{\"weight\":" + String(weightKg, 3) + "}");
```

---

## Status Labels Translation

Backend now provides human-readable status labels:

| Status (Database)        | Label (UI)      |
|-------------------------|-----------------|
| pending_locker          | Menunggu kurir  |
| assigned_to_locker      | Ditugaskan ke locker |
| delivered_to_locker     | Di locker       |
| ready_for_pickup        | Siap diambil    |
| delivered_to_customer   | Sudah diambil   |
| completed               | Selesai         |

---

## Troubleshooting

### Weight Still Not Showing?
1. Check if courier app sends `weight` parameter
2. Check backend logs for: `[⚠️  NO WEIGHT]` message
3. Use test endpoint to manually add weight
4. Verify mobile app is using new endpoint

### Tracking Not Showing?
1. Use new endpoint: `/api/customer/shipments/:resi`
2. Check `tracking.available` field in response
3. Logs are stored in `shipment.logs` array

### Need to Test?
```bash
# Add test weight
Invoke-WebRequest -Uri "http://192.168.0.56:3000/api/test/set-weight" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"resi":"TG7007260622","weight":1.5}'

# Verify it worked
Invoke-WebRequest -Uri "http://192.168.0.56:3000/api/shipments/TG7007260622/weight" `
  -Method Get
```

---

## Summary

✅ **Weight System:** Backend ready, needs courier app/ESP32 to send weight  
✅ **Tracking System:** New endpoint provides formatted tracking history  
✅ **Test Endpoint:** Can manually add weight for testing  
✅ **Mobile Integration:** Use new `/api/customer/shipments/:resi` endpoint  

**Next Steps:**
1. Run test endpoint to add weight to TG7007260622
2. Update mobile app to use new endpoints
3. Test weight display and tracking in app
4. Configure courier app to send weight parameter
