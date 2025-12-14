/**
 * Load Test Script for Smart Locker API
 * Monitor results in Grafana dashboard
 */

const axios = require('axios');

const API_BASE = 'http://100.83.50.122:3000';
const DURATION_MINUTES = 5; // Test duration
const REQUESTS_PER_SECOND = 10; // RPS per endpoint

// Test data
const TEST_DATA = {
  customerId: '908452',
  courierId: 'courier123',
  lockerId: 'tesutoxx',
  resi: 'JX6246122702',
  token: 'test-token-123'
};

// Endpoint configurations
const ENDPOINTS = [
  {
    name: 'GET /api/couriers',
    method: 'GET',
    url: '/api/couriers',
    weight: 3 // How often to hit (higher = more frequent)
  },
  {
    name: 'GET /api/lockers',
    method: 'GET',
    url: '/api/lockers',
    weight: 3
  },
  {
    name: 'GET /api/customers',
    method: 'GET',
    url: '/api/customers',
    weight: 2
  },
  {
    name: 'GET /api/shipments',
    method: 'GET',
    url: '/api/shipments',
    weight: 3
  },
  {
    name: 'GET /api/manual-resi',
    method: 'GET',
    url: '/api/manual-resi',
    weight: 2
  },
  {
    name: 'GET /api/agent/active-resi',
    method: 'GET',
    url: '/api/agent/active-resi',
    weight: 2
  },
  {
    name: 'GET /api/metrics/custom',
    method: 'GET',
    url: '/api/metrics/custom',
    weight: 1
  },
  {
    name: 'GET /api/metrics/summary',
    method: 'GET',
    url: '/api/metrics/summary',
    weight: 1
  }
];

// Statistics tracking
const stats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  responseTimes: [],
  errors: {},
  startTime: Date.now()
};

// Make a single request
async function makeRequest(endpoint) {
  const startTime = Date.now();
  
  try {
    const config = {
      method: endpoint.method,
      url: `${API_BASE}${endpoint.url}`,
      timeout: 30000
    };

    if (endpoint.data) {
      config.data = endpoint.data;
    }

    const response = await axios(config);
    const duration = Date.now() - startTime;
    
    stats.totalRequests++;
    stats.successRequests++;
    stats.responseTimes.push(duration);
    
    return { success: true, duration, status: response.status };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    stats.totalRequests++;
    stats.failedRequests++;
    
    const errorKey = error.response?.status || error.code || 'UNKNOWN';
    stats.errors[errorKey] = (stats.errors[errorKey] || 0) + 1;
    
    return { 
      success: false, 
      duration, 
      error: errorKey,
      endpoint: endpoint.name 
    };
  }
}

// Select random endpoint based on weights
function selectEndpoint() {
  const totalWeight = ENDPOINTS.reduce((sum, e) => sum + e.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const endpoint of ENDPOINTS) {
    random -= endpoint.weight;
    if (random <= 0) {
      return endpoint;
    }
  }
  
  return ENDPOINTS[0];
}

// Print statistics
function printStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rps = stats.totalRequests / elapsed;
  
  const sortedTimes = [...stats.responseTimes].sort((a, b) => a - b);
  const p50 = sortedTimes[Math.floor(sortedTimes.length * 0.50)] || 0;
  const p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)] || 0;
  const p99 = sortedTimes[Math.floor(sortedTimes.length * 0.99)] || 0;
  const avg = sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length || 0;
  const min = sortedTimes[0] || 0;
  const max = sortedTimes[sortedTimes.length - 1] || 0;
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 LOAD TEST STATISTICS');
  console.log('='.repeat(70));
  console.log(`Duration:        ${elapsed.toFixed(2)}s`);
  console.log(`Total Requests:  ${stats.totalRequests}`);
  console.log(`Success:         ${stats.successRequests} (${(stats.successRequests/stats.totalRequests*100).toFixed(2)}%)`);
  console.log(`Failed:          ${stats.failedRequests} (${(stats.failedRequests/stats.totalRequests*100).toFixed(2)}%)`);
  console.log(`RPS:             ${rps.toFixed(2)} requests/sec`);
  console.log('');
  console.log('Response Times (ms):');
  console.log(`  Min:     ${min.toFixed(2)}ms`);
  console.log(`  Max:     ${max.toFixed(2)}ms`);
  console.log(`  Average: ${avg.toFixed(2)}ms`);
  console.log(`  p50:     ${p50.toFixed(2)}ms`);
  console.log(`  p95:     ${p95.toFixed(2)}ms`);
  console.log(`  p99:     ${p99.toFixed(2)}ms`);
  
  if (Object.keys(stats.errors).length > 0) {
    console.log('');
    console.log('Errors:');
    Object.entries(stats.errors).forEach(([code, count]) => {
      console.log(`  ${code}: ${count}`);
    });
  }
  console.log('='.repeat(70));
  console.log('');
}

// Run load test
async function runLoadTest() {
  console.log('🚀 Starting Load Test...');
  console.log(`Target: ${API_BASE}`);
  console.log(`Duration: ${DURATION_MINUTES} minutes`);
  console.log(`Target RPS: ~${REQUESTS_PER_SECOND} requests/second`);
  console.log(`Total endpoints: ${ENDPOINTS.length}`);
  console.log('');
  console.log('✅ Open Grafana to monitor: http://100.91.45.23:3002');
  console.log('📊 Dashboard: Smart Locker API - Thesis Monitoring Dashboard');
  console.log('');
  console.log('Press Ctrl+C to stop the test early');
  console.log('');
  
  const endTime = Date.now() + (DURATION_MINUTES * 60 * 1000);
  const intervalMs = 1000 / REQUESTS_PER_SECOND;
  
  let requestCount = 0;
  
  while (Date.now() < endTime) {
    const batchPromises = [];
    
    // Send batch of concurrent requests
    for (let i = 0; i < REQUESTS_PER_SECOND; i++) {
      const endpoint = selectEndpoint();
      batchPromises.push(makeRequest(endpoint));
    }
    
    await Promise.all(batchPromises);
    requestCount += REQUESTS_PER_SECOND;
    
    // Print progress every 10 seconds
    if (requestCount % 100 === 0) {
      const elapsed = (Date.now() - stats.startTime) / 1000;
      const currentRps = stats.totalRequests / elapsed;
      console.log(`⏱️  ${elapsed.toFixed(0)}s | Requests: ${stats.totalRequests} | RPS: ${currentRps.toFixed(2)} | Success: ${stats.successRequests} | Failed: ${stats.failedRequests}`);
    }
    
    // Wait before next batch
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  console.log('\n✅ Load test completed!\n');
  printStats();
  
  console.log('📊 Check Grafana for detailed metrics:');
  console.log('   - Response time graphs');
  console.log('   - Request rate per endpoint');
  console.log('   - Status code distribution');
  console.log('   - Latency percentiles (p50, p90, p95, p99)');
  console.log('');
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Test interrupted by user\n');
  printStats();
  process.exit(0);
});

// Start the test
console.clear();
runLoadTest().catch(err => {
  console.error('❌ Load test failed:', err.message);
  process.exit(1);
});
