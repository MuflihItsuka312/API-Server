# 📊 THESIS DATA COLLECTION GUIDE

## Overview
Your Smart Locker API now collects **professional-grade metrics** suitable for academic research. This includes latency, throughput, success rates, and system performance data.

---

## 🎯 What Data is Being Collected

### 1. **API Response Time Metrics**
- **Average latency** per endpoint
- **p50, p90, p95, p99 percentiles** (industry standard)
- **Distribution histograms** for detailed analysis
- Breakdown by HTTP method and status code

### 2. **Request Throughput**
- Requests per second (RPS) per endpoint
- Total request counts
- Success vs error rates
- Status code distribution (200, 400, 500, etc.)

### 3. **External API Performance**
- Binderbyte API response times
- Success/failure rates
- Timeout tracking

### 4. **Locker Operations**
- Deposit operations count
- QR scan success/failure rates
- Courier vs customer operations
- Per-locker performance

### 5. **System Resources**
- CPU usage
- Memory consumption
- Node.js event loop lag
- Garbage collection metrics

---

## 📡 How to Access the Data

### Option 1: Prometheus Metrics (Raw Data)
```bash
# Main metrics endpoint (includes express-prom-bundle metrics)
curl http://localhost:3000/metrics

# Custom metrics endpoint (your thesis-specific metrics)
curl http://localhost:3000/api/metrics/custom
```

### Option 2: JSON Summary (Human-Readable)
```bash
curl http://localhost:3000/api/metrics/summary | jq
```

### Option 3: Grafana Dashboard (Visual)
1. Open Grafana: http://localhost:3002
2. Login: admin / admin
3. Go to: **Dashboards → Import**
4. Upload: `grafana-dashboard.json`
5. Select Prometheus datasource
6. Click **Import**

---

## 📈 Grafana Dashboard Features

Your custom dashboard includes:

### Panel 1: **API Endpoint Response Time (Average)**
- Line graph showing average latency over time
- Grouped by endpoint
- **Use for:** Identifying slow endpoints

### Panel 2: **API Response Time (p95 & p99)**
- Gauge showing 95th and 99th percentile latency
- **Use for:** SLA compliance, worst-case analysis

### Panel 3: **API Request Rate**
- Requests per second by endpoint
- **Use for:** Traffic patterns, load analysis

### Panel 4: **HTTP Status Code Distribution**
- Pie chart of 2xx, 4xx, 5xx responses
- **Use for:** Error rate analysis

### Panel 5: **External API Response Time**
- Binderbyte API latency tracking
- **Use for:** Third-party dependency analysis

### Panel 6: **Locker Operations & QR Scans**
- Stats on successful operations
- **Use for:** System usage metrics

### Panel 7: **Latency Percentiles (THESIS DATA)**
- Bar chart with p50, p90, p95, p99
- **Use for:** Performance distribution analysis

---

## 🔬 Collecting Data for Your Thesis

### Step 1: Generate Test Load
Run realistic traffic against your API:

```bash
# Install load testing tool
npm install -g autocannon

# Test manual-resi endpoint (most important)
autocannon -c 10 -d 60 http://localhost:3000/api/manual-resi

# Test courier deposit
autocannon -c 5 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"lockerId":"LOCKER-001","lockerToken":"test","resi":"12345"}' \
  http://localhost:3000/api/courier/deposit-resi
```

### Step 2: Export Metrics from Prometheus

#### Export as CSV (for Excel/SPSS)
```bash
# Install promtool
# Windows: Download from https://prometheus.io/download/

# Query and export
curl -G http://localhost:9090/api/v1/query \
  --data-urlencode 'query=http_request_duration_seconds_bucket' \
  | jq -r '.data.result[] | [.metric.route, .metric.status_code, .value[1]] | @csv' \
  > thesis_data.csv
```

#### Export Time Series Data
```bash
# Export last hour of data
curl -G http://localhost:9090/api/v1/query_range \
  --data-urlencode 'query=rate(http_request_duration_seconds_sum[5m])/rate(http_request_duration_seconds_count[5m])' \
  --data-urlencode 'start='$(date -u -d '1 hour ago' +%s) \
  --data-urlencode 'end='$(date -u +%s) \
  --data-urlencode 'step=15s' \
  | jq '.data.result' > timeseries_data.json
```

### Step 3: Screenshot Grafana Graphs
1. Open each panel in Grafana
2. Click panel title → **View**
3. Click **Share** → **Snapshot** or take screenshot
4. Use in thesis document

---

## 📊 Key Metrics for Thesis Analysis

### Table 1: API Endpoint Performance Summary
| Endpoint | Avg Latency | p95 Latency | p99 Latency | RPS | Success Rate |
|----------|-------------|-------------|-------------|-----|--------------|
| GET /api/manual-resi | X ms | X ms | X ms | X | XX% |
| POST /api/courier/deposit-resi | X ms | X ms | X ms | X | XX% |
| GET /api/agent/active-resi | X ms | X ms | X ms | X | XX% |

**Query to get this data:**
```promql
# Average latency
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])

# p95 latency
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# p99 latency
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# Request rate
rate(http_requests_total[1m])

# Success rate
sum(rate(http_requests_total{status_code=~"2.."}[5m])) / sum(rate(http_requests_total[5m])) * 100
```

### Table 2: External API Performance
| API | Avg Response Time | Timeout Rate | Success Rate |
|-----|-------------------|--------------|--------------|
| Binderbyte Track | X ms | X% | XX% |

**Query:**
```promql
rate(external_api_duration_seconds_sum{api="binderbyte"}[5m]) / rate(external_api_duration_seconds_count{api="binderbyte"}[5m])
```

### Table 3: System Performance Under Load
| Concurrent Users | Avg Response Time | p99 Latency | CPU Usage | Memory Usage |
|------------------|-------------------|-------------|-----------|--------------|
| 10 | X ms | X ms | X% | X MB |
| 50 | X ms | X ms | X% | X MB |
| 100 | X ms | X ms | X% | X MB |

**Query:**
```promql
# CPU usage
rate(process_cpu_seconds_total[5m]) * 100

# Memory usage
process_resident_memory_bytes / 1024 / 1024
```

---

## 📝 Sample Thesis Statements

### Performance Analysis
"The Smart Locker API achieved an average response time of **X ms** for the manual resi validation endpoint, with 95% of requests completing within **X ms** (p95 latency). Under load testing with 50 concurrent users, the system maintained a **99.X% success rate** while processing **X requests per second**."

### Comparison with Baseline
"Compared to the baseline implementation, the optimized API with global caching reduced average latency by **X%**, from **X ms** to **X ms**, while the p99 latency improved by **X%**."

### External Dependency Impact
"External API calls to Binderbyte averaged **X seconds**, representing **X%** of the total request latency. The implementation of smart courier detection reduced failed API attempts by **X%**."

---

## 🔍 Advanced Queries

### Find Slowest Endpoints
```promql
topk(5, rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m]))
```

### Error Rate by Endpoint
```promql
sum by (route) (rate(http_requests_total{status_code=~"5.."}[5m])) / sum by (route) (rate(http_requests_total[5m])) * 100
```

### Request Distribution Heatmap
```promql
sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))
```

### Locker Utilization
```promql
rate(locker_operations_total{operation="deposit", status="success"}[5m])
```

---

## 📦 Export All Data for Analysis

### Option 1: Prometheus Snapshot
```bash
# Take full Prometheus snapshot
curl -X POST http://localhost:9090/api/v1/admin/tsdb/snapshot
# Data saved to: data/snapshots/
```

### Option 2: PromQL to CSV Script
```bash
#!/bin/bash
# Save as export_metrics.sh

QUERIES=(
  "rate(http_request_duration_seconds_sum[5m])/rate(http_request_duration_seconds_count[5m])"
  "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
  "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))"
  "rate(http_requests_total[1m])"
)

for query in "${QUERIES[@]}"; do
  curl -G http://localhost:9090/api/v1/query \
    --data-urlencode "query=$query" \
    | jq -r '.data.result[] | [.metric.route, .value[1]] | @csv'
done > all_metrics.csv
```

### Option 3: Grafana CSV Export
1. Open any panel
2. Click **Inspect** → **Data**
3. Click **Download CSV**

---

## 🎓 Tips for Thesis Writing

### 1. **Run Tests Multiple Times**
- Run each test scenario 3-5 times
- Calculate mean and standard deviation
- Report confidence intervals

### 2. **Document Test Environment**
```
- Server: Node.js vXX.XX
- OS: Windows XX / Ubuntu XX
- CPU: X cores, X GHz
- RAM: X GB
- Database: MongoDB vX.X
- Network: Localhost / X Mbps
```

### 3. **Include Visualizations**
- Use Grafana screenshots (high quality)
- Include time-series graphs for latency
- Add pie charts for status code distribution
- Use box plots for percentile distribution

### 4. **Statistical Analysis**
- Calculate mean, median, std deviation
- Perform t-tests for before/after comparisons
- Report confidence intervals (95% CI)
- Use ANOVA for multi-condition comparisons

### 5. **Interpret Results**
- Compare against industry benchmarks (e.g., "p99 < 1s")
- Identify bottlenecks
- Discuss scalability implications
- Recommend optimizations

---

## 🚀 Quick Start Checklist

- [ ] Server running with metrics enabled
- [ ] Prometheus scraping at http://localhost:3000/metrics
- [ ] Grafana dashboard imported
- [ ] Load testing tool installed
- [ ] Run initial test traffic
- [ ] Verify metrics appearing in Grafana
- [ ] Export sample data to CSV
- [ ] Document test environment
- [ ] Take screenshots for thesis
- [ ] Calculate statistical measures

---

## 📞 Troubleshooting

### Metrics not appearing?
```bash
# Check if metrics endpoint works
curl http://localhost:3000/metrics | head -20

# Verify Prometheus target
# Open http://localhost:9090/targets
# Status should be "UP"
```

### Grafana shows "No Data"?
1. Check Prometheus datasource: **Configuration → Data Sources**
2. URL should be: `http://prometheus:9090` or `http://localhost:9090`
3. Click **Save & Test**

### Want more metrics?
Add custom metrics in `app.js`:
```javascript
const myCustomMetric = new promClient.Counter({
  name: 'my_custom_metric',
  help: 'Description',
  labelNames: ['label1', 'label2'],
  registers: [register],
});

// Use it
myCustomMetric.labels('value1', 'value2').inc();
```

---

## 📚 References for Thesis

- **Prometheus Documentation**: https://prometheus.io/docs/
- **Grafana Tutorials**: https://grafana.com/tutorials/
- **Performance Testing**: Google's SRE Book (Chapter 6)
- **Latency Percentiles**: Gil Tene - "How NOT to Measure Latency"

---

**Good luck with your thesis! 🎓**
