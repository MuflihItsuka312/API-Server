# 🎯 QUICK START: Thesis Data Collection

## ✅ What's Now Available

Your API now has **professional monitoring** with these endpoints:

### 📊 Data Collection Endpoints

1. **Main Prometheus Metrics**
   ```
   http://localhost:3000/metrics
   ```
   - Includes ALL metrics (default + custom)
   - Used by Prometheus for scraping

2. **Custom Thesis Metrics**
   ```
   http://localhost:3000/api/metrics/custom
   ```
   - Your specific thesis metrics only
   - Prometheus format

3. **Human-Readable Summary**
   ```
   http://localhost:3000/api/metrics/summary
   ```
   - JSON format for easy analysis
   - Endpoint statistics

---

## 📈 What Gets Measured Automatically

### ✅ API Performance
- ✅ Response time per endpoint (avg, p50, p90, p95, p99)
- ✅ Request rate (requests per second)
- ✅ Success/error rates
- ✅ Status code distribution

### ✅ External APIs
- ✅ Binderbyte API response time
- ✅ Timeout tracking
- ✅ Success/failure rates

### ✅ Business Metrics
- ✅ QR code scans (courier vs customer)
- ✅ Locker operations (deposit, pickup)
- ✅ Shipment status tracking

### ✅ System Resources
- ✅ CPU usage
- ✅ Memory consumption
- ✅ Node.js performance

---

## 🚀 How to Collect Data for Your Thesis

### Step 1: Run Your Tests
Just use your API normally! Metrics are collected automatically:

```bash
# Example: Test manual resi endpoint
curl http://localhost:3000/api/manual-resi

# Example: Test courier deposit
curl -X POST http://localhost:3000/api/courier/deposit-resi \
  -H "Content-Type: application/json" \
  -d '{"lockerId":"LOCKER-001","lockerToken":"test","resi":"12345"}'
```

### Step 2: View Metrics in Grafana
1. Open: http://localhost:3002 (admin/admin)
2. Import dashboard: `grafana-dashboard.json`
3. Take screenshots for thesis

### Step 3: Export Data
```bash
# Get metrics as JSON
curl http://localhost:3000/api/metrics/summary > data.json

# Get Prometheus format
curl http://localhost:3000/api/metrics/custom > data.txt
```

---

## 📊 Sample Thesis Table

After running tests, you can create tables like this:

| Endpoint | Avg Latency | p95 | p99 | RPS | Success % |
|----------|-------------|-----|-----|-----|-----------|
| /api/manual-resi | 245ms | 450ms | 680ms | 12.5 | 99.2% |
| /api/courier/deposit-resi | 89ms | 150ms | 200ms | 8.3 | 99.8% |
| /api/agent/active-resi | 35ms | 60ms | 85ms | 15.7 | 100% |

**Data Source:** Extract from Grafana or Prometheus queries

---

## 🎓 Key Metrics for Thesis

### 1. **Latency Analysis**
- **p50** = Median response time (50% of requests)
- **p95** = 95% of requests complete within this time
- **p99** = 99% of requests complete within this time (worst case)

### 2. **Throughput**
- **RPS** = Requests per second
- Shows system capacity

### 3. **Reliability**
- **Success Rate** = % of 2xx responses
- **Error Rate** = % of 4xx/5xx responses

### 4. **External Dependencies**
- **Binderbyte Latency** = Third-party API impact
- Shows bottlenecks

---

## 🔍 Accessing Metrics in Prometheus

1. Open: http://localhost:9090
2. Try these queries:

```promql
# Average response time by endpoint
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])

# p95 latency
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Request rate
rate(http_requests_total[1m])

# Success rate
sum(rate(http_requests_total{status_code=~"2.."}[5m])) / sum(rate(http_requests_total[5m])) * 100
```

---

## 📁 Files Created

1. **grafana-dashboard.json** - Import this into Grafana
2. **THESIS_DATA_GUIDE.md** - Complete guide (read this!)
3. **app.js** - Updated with metrics collection

---

## ⚡ Quick Test

```bash
# 1. Make some requests
for i in {1..100}; do
  curl http://localhost:3000/api/manual-resi
  sleep 0.1
done

# 2. Check metrics
curl http://localhost:3000/api/metrics/summary | jq

# 3. View in Grafana
# Open http://localhost:3002
```

---

## 📞 Next Steps

1. ✅ **Import Grafana Dashboard**
   - Open Grafana → Dashboards → Import
   - Upload `grafana-dashboard.json`

2. ✅ **Run Load Tests**
   - Use your mobile apps or curl
   - Generate realistic traffic

3. ✅ **Export Data**
   - Take Grafana screenshots
   - Export CSV from Prometheus
   - Use in thesis

4. ✅ **Analyze Results**
   - Calculate statistics (mean, std dev)
   - Compare scenarios
   - Write conclusions

---

## 🎯 Your Thesis Data is Now Being Collected!

Every API call is automatically tracked. Just use your system normally and the data will be ready for analysis.

**Full documentation:** See `THESIS_DATA_GUIDE.md`
