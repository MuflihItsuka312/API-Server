# Test HIGH CONFIDENCE Pattern Detection

Write-Host "`n===========" -ForegroundColor Cyan
Write-Host " PATTERN TEST" -ForegroundColor Cyan  
Write-Host "===========`n" -ForegroundColor Cyan

# Test 1: SiCepat (00-prefix)
Write-Host "1. Testing SiCepat (005252506571)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/customer/track/005252506571" -Method Get -TimeoutSec 10
    Write-Host "   ✅ Success: $($response.success)" -ForegroundColor Green
    Write-Host "   Courier: $($response.courierType)"
    Write-Host "   Method: $($response.validationMethod)"
    Write-Host "   Message: $($response.message)`n"
} catch {
    Write-Host "   ❌ Error: $($_.Exception.Message)`n" -ForegroundColor Red
}

# Test 2: TIKI (TKP-prefix)  
Write-Host "2. Testing TIKI (TKP4003574518)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/customer/track/TKP4003574518" -Method Get -TimeoutSec 10
    Write-Host "   ✅ Success: $($response.success)" -ForegroundColor Green
    Write-Host "   Courier: $($response.courierType)"
    Write-Host "   Method: $($response.validationMethod)"  
    Write-Host "   Message: $($response.message)`n"
} catch {
    Write-Host "   ❌ Error: $($_.Exception.Message)`n" -ForegroundColor Red
}

# Test 3: JNE (TG-prefix)
Write-Host "3. Testing JNE (TG3530937431)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/customer/track/TG3530937431" -Method Get -TimeoutSec 10
    Write-Host "   ✅ Success: $($response.success)" -ForegroundColor Green
    Write-Host "   Courier: $($response.courierType)"
    Write-Host "   Method: $($response.validationMethod)"
    Write-Host "   Message: $($response.message)`n"
} catch {
    Write-Host "   ❌ Error: $($_.Exception.Message)`n" -ForegroundColor Red
}

Write-Host "===========`n" -ForegroundColor Cyan
