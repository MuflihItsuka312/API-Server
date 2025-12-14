# OpenTelemetry Integration

## Overview
This API is instrumented with OpenTelemetry for distributed tracing and observability.

## What's Traced
- **HTTP Requests**: All incoming API requests with timing
- **Express Routes**: Route handlers and middleware
- **MongoDB Operations**: Database queries and operations
- **External HTTP Calls**: Axios requests to Binderbyte API

## Configuration

### Environment Variables
Set in `.env` file:
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

### Supported Backends

#### 1. **Local OpenTelemetry Collector** (Recommended for Development)
Run with Docker:
```bash
docker run -d -p 4318:4318 -p 4317:4317 \
  otel/opentelemetry-collector-contrib:latest
```

#### 2. **Jaeger** (Easy Visualization)
Run with Docker:
```bash
docker run -d -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest
```
Then access UI at: http://localhost:16686

#### 3. **Grafana + Tempo** (Production-Ready)
```bash
# docker-compose.yml example
version: '3'
services:
  tempo:
    image: grafana/tempo:latest
    ports:
      - "4318:4318"
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
```

#### 4. **Cloud Services**
- **Grafana Cloud**: Update endpoint to your Grafana Cloud OTLP endpoint
- **New Relic**: https://otlp.nr-data.net:4318/v1/traces
- **Datadog**: https://trace.agent.datadoghq.com/v0.4/traces
- **Honeycomb**: https://api.honeycomb.io/v1/traces

## Quick Start with Jaeger

1. **Start Jaeger**:
   ```bash
   docker run -d --name jaeger \
     -p 16686:16686 \
     -p 4318:4318 \
     jaegertracing/all-in-one:latest
   ```

2. **Start your API**:
   ```bash
   npm start
   ```

3. **Make some requests** to your API:
   ```bash
   curl http://localhost:3000/api/manual-resi
   ```

4. **View traces** at http://localhost:16686
   - Select service: `smart-locker-api`
   - Click "Find Traces"

## Trace Data Examples

### HTTP Request Trace
```
Span: GET /api/manual-resi
├─ MongoDB Query: customer_trackings.find()
├─ HTTP Request: Binderbyte API
└─ MongoDB Insert: customer_trackings.save()
Duration: 245ms
```

### Courier Deposit Trace
```
Span: POST /api/courier/deposit-resi
├─ MongoDB Query: shipments.findOne()
├─ MongoDB Query: lockers.findOne()
├─ MongoDB Update: lockers.updateOne()
└─ MongoDB Insert: notifications.save()
Duration: 89ms
```

## Custom Spans (Optional)

You can add custom spans for specific operations:

```javascript
const { trace } = require('@opentelemetry/api');

async function mySlowOperation() {
  const tracer = trace.getTracer('my-service');
  const span = tracer.startSpan('mySlowOperation');
  
  try {
    // Your code here
    span.setAttribute('custom.attribute', 'value');
  } finally {
    span.end();
  }
}
```

## Disabling Tracing

To disable OpenTelemetry (e.g., for local development without collector):

1. Comment out the require in `app.js`:
   ```javascript
   // require('./tracing');
   ```

2. Or set environment variable:
   ```bash
   OTEL_SDK_DISABLED=true
   ```

## Troubleshooting

### No traces appearing?
1. Check collector is running: `curl http://localhost:4318/v1/traces`
2. Check console logs for `[OpenTelemetry] Tracing initialized successfully`
3. Verify `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env`

### Too much data?
Adjust sampling in `tracing.js`:
```javascript
const sdk = new NodeSDK({
  sampler: new TraceIdRatioBasedSampler(0.1), // Sample 10% of traces
  // ...
});
```

## Performance Impact

OpenTelemetry adds minimal overhead:
- ~1-3ms per HTTP request
- ~0.5ms per MongoDB operation
- Memory: ~20-50MB

## Resources

- [OpenTelemetry Docs](https://opentelemetry.io/docs/)
- [Jaeger UI](https://www.jaegertracing.io/)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
