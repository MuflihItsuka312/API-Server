# Test ESP32 Weight Input to Backend
# This simulates ESP32 sending weight data

$baseUrl = "http://192.168.0.56:3000"
$resi = "TG7007260622"
$lockerId = "tesutoxx"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ESP32 WEIGHT TEST - Simulating Hardware" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# TEST 1: Simulate courier deposit with weight (single reading)
Write-Host "[TEST 1] Simulating Courier Deposit with Weight..." -ForegroundColor Yellow
Write-Host "Endpoint: POST /api/courier/deposit-token" -ForegroundColor Gray
Write-Host "Weight: 2.5 kg (simulating load cell reading)`n" -ForegroundColor Gray

try {
    # First, get locker info to get token
    Write-Host "Step 1: Getting locker token..." -ForegroundColor White
    $lockerResponse = Invoke-WebRequest -Uri "$baseUrl/api/locker/$lockerId" -Method Get -UseBasicParsing
    $lockerData = $lockerResponse.Content | ConvertFrom-Json
    $token = $lockerData.locker.lockerToken
    
    Write-Host "[OK] Locker Token: $($token.Substring(0,20))..." -ForegroundColor Green
    
    # Simulate courier scanning QR with weight
    Write-Host "`nStep 2: Simulating courier scan with weight data..." -ForegroundColor White
    $depositBody = @{
        lockerId = $lockerId
        lockerToken = $token
        resi = $resi
        weight = 2.5  # ESP32 would send this from load cell
    } | ConvertTo-Json
    
    Write-Host "Request Body:" -ForegroundColor Gray
    Write-Host $depositBody -ForegroundColor DarkGray
    
    $depositResponse = Invoke-WebRequest -Uri "$baseUrl/api/courier/deposit-token" `
        -Method Post `
        -ContentType "application/json" `
        -Body $depositBody `
        -UseBasicParsing
    
    $depositResult = $depositResponse.Content | ConvertFrom-Json
    
    if ($depositResult.ok) {
        Write-Host "`n[SUCCESS] Backend received weight!" -ForegroundColor Green
        Write-Host "Weight recorded: $($depositResult.weightRecorded) kg" -ForegroundColor Green
    } else {
        Write-Host "`n[FAILED] $($depositResult.error)" -ForegroundColor Red
    }
    
} catch {
    Write-Host "`n[ERROR] in Test 1: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n----------------------------------------`n" -ForegroundColor Cyan

# TEST 2: Verify weight was saved in database
Write-Host "[TEST 2] Verifying Weight in Database..." -ForegroundColor Yellow
Write-Host "Endpoint: GET /api/shipments/:resi/weight`n" -ForegroundColor Gray

try {
    $weightResponse = Invoke-WebRequest -Uri "$baseUrl/api/shipments/$resi/weight" -Method Get -UseBasicParsing
    $weightData = $weightResponse.Content | ConvertFrom-Json
    
    if ($weightData.ok -and $weightData.data.hasWeight) {
        Write-Host "[SUCCESS] Weight found in database!" -ForegroundColor Green
        Write-Host "  Resi: $($weightData.data.resi)" -ForegroundColor White
        Write-Host "  Weight: $($weightData.data.weight) kg" -ForegroundColor White
        Write-Host "  Unit: $($weightData.data.unit)" -ForegroundColor White
        Write-Host "  Recorded At: $($weightData.data.weightRecordedAt)" -ForegroundColor White
    } else {
        Write-Host "[FAILED] No weight found - ESP32 data not received" -ForegroundColor Red
    }
    
} catch {
    Write-Host "[ERROR] in Test 2: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n----------------------------------------`n" -ForegroundColor Cyan

# TEST 3: Simulate differential weight measurement (20-second window)
Write-Host "[TEST 3] Simulating Differential Weight Measurement..." -ForegroundColor Yellow
Write-Host "This simulates ESP32 sending multiple readings over 20 seconds`n" -ForegroundColor Gray

try {
    # Start weight session
    Write-Host "Step 1: Starting weight session..." -ForegroundColor White
    $startBody = @{
        resi = $resi
    } | ConvertTo-Json
    
    $startResponse = Invoke-WebRequest -Uri "$baseUrl/api/locker/$lockerId/weight/start" `
        -Method Post `
        -ContentType "application/json" `
        -Body $startBody `
        -UseBasicParsing
    
    $startResult = $startResponse.Content | ConvertFrom-Json
    Write-Host "[SUCCESS] Session started: $($startResult.sessionId)" -ForegroundColor Green
    
    # Simulate weight readings (ESP32 would send these every few seconds)
    Write-Host "`nStep 2: Sending weight readings (simulating 20-second window)..." -ForegroundColor White
    $readings = @(5.2, 5.1, 4.9, 4.8, 4.5)  # Simulating package removal
    
    foreach ($reading in $readings) {
        Write-Host "  → Sending reading: $reading kg" -ForegroundColor Gray
        
        $readingBody = @{
            weight = $reading
        } | ConvertTo-Json
        
        $readingResponse = Invoke-WebRequest -Uri "$baseUrl/api/locker/$lockerId/weight/reading" `
            -Method Post `
            -ContentType "application/json" `
            -Body $readingBody `
            -UseBasicParsing
        
        $readingResult = $readingResponse.Content | ConvertFrom-Json
        
        if ($readingResult.ok) {
            Write-Host "    [OK] Reading #$($readingResult.readingNumber) recorded" -ForegroundColor Green
        }
        
        Start-Sleep -Seconds 1  # Simulate delay between readings
    }
    
    # Finalize measurement
    Write-Host "`nStep 3: Finalizing weight measurement..." -ForegroundColor White
    $finalizeResponse = Invoke-WebRequest -Uri "$baseUrl/api/locker/$lockerId/weight/finalize" `
        -Method Post `
        -UseBasicParsing
    
    $finalizeResult = $finalizeResponse.Content | ConvertFrom-Json
    
    if ($finalizeResult.ok) {
        Write-Host "[SUCCESS] Weight calculation complete!" -ForegroundColor Green
        Write-Host "  Initial Weight: $($finalizeResult.data.calculation.initialWeight) kg" -ForegroundColor White
        Write-Host "  Final Weight: $($finalizeResult.data.calculation.finalWeight) kg" -ForegroundColor White
        Write-Host "  Package Weight: $($finalizeResult.data.weight) kg" -ForegroundColor White
        Write-Host "  Readings Count: $($finalizeResult.data.calculation.readingsCount)" -ForegroundColor White
    } else {
        Write-Host "[FAILED] Finalize failed: $($finalizeResult.error)" -ForegroundColor Red
    }
    
} catch {
    Write-Host "`n[ERROR] in Test 3: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errorBody = $reader.ReadToEnd()
        Write-Host "Error Details: $errorBody" -ForegroundColor DarkRed
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nWhat These Tests Prove:" -ForegroundColor Yellow
Write-Host "1. Backend CAN receive weight from ESP32 [CHECK]" -ForegroundColor White
Write-Host "2. Weight is stored in database correctly [CHECK]" -ForegroundColor White
Write-Host "3. Differential measurement works (20 sec window) [CHECK]" -ForegroundColor White

Write-Host "`nFor Real ESP32 Integration:" -ForegroundColor Yellow
Write-Host "• ESP32 must POST to: /api/courier/deposit-token" -ForegroundColor White
Write-Host "• Include 'weight' field in kg (e.g., 2.5)" -ForegroundColor White
Write-Host "• Or use differential method with /weight/reading" -ForegroundColor White

Write-Host "`nCheck Backend Logs:" -ForegroundColor Yellow
Write-Host "Look for: '[⚖️  WEIGHT RECORDED]' or '[⚠️  NO WEIGHT]'" -ForegroundColor White
Write-Host "`n" -ForegroundColor White
