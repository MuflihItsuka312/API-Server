// tracing.js - OpenTelemetry Configuration
// This file MUST be required before any other modules
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

// Configure the OTLP exporter (adjust URL to your collector)
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://100.91.45.23:4318/v1/traces',
  headers: {},
});

// Create the SDK with resource attributes
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'smart-locker-api',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Customize auto-instrumentation
      '@opentelemetry/instrumentation-fs': {
        enabled: false, // Disable file system tracing (too noisy)
      },
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        ignoreIncomingPaths: ['/health'], // Don't trace health checks
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-mongodb': {
        enabled: true,
      },
    }),
  ],
});

// Start the SDK (v0.56.0 doesn't return a promise)
try {
  sdk.start();
  console.log('[OpenTelemetry] Tracing initialized successfully');
  console.log(`[OpenTelemetry] Exporting to: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://100.91.45.23:4318/v1/traces'}`);
} catch (error) {
  console.error('[OpenTelemetry] Error initializing tracing:', error);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[OpenTelemetry] Tracing terminated'))
    .catch((error) => console.error('[OpenTelemetry] Error terminating tracing', error))
    .finally(() => process.exit(0));
});

module.exports = sdk;
