# Test Opening Locker to Trigger Weight Transmission
# This simulates a courier scanning the QR code to deposit a package

$baseUrl = "http://localhost:3000"
$lockerId = "tesutoxx"
$testResi = "TEST" + (Get-Date -Format "HHmmss")  # Generate unique test resi

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "OPEN LOCKER TEST - Trigger Weight Data" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "Test Resi: $testResi" -ForegroundColor Yellow
Write-Host "Locker ID: $lockerId`n" -ForegroundColor Yellow

try {
    # Step 1: Get locker token
    Write-Host "[Step 1] Getting locker token..." -ForegroundColor White
    $lockerResponse = Invoke-RestMethod -Uri "$baseUrl/api/locker/$lockerId/token" -Method Get
    $token = $lockerResponse.lockerToken
    Write-Host "[OK] Token: $($token.Substring(0, 20))...`n" -ForegroundColor Green

    # Step 2: Create a test shipment (basic shipment creation)
    Write-Host "[Step 2] Creating test shipment..." -ForegroundColor White
    $shipmentBody = @{
        lockerId = $lockerId
        courierType = "jnt"
        resiList = @($testResi)
        receiverName = "Test Recipient"
        receiverPhone = "08222222222"
        customerId = "default"
    } | ConvertTo-Json

    $shipmentResponse = Invoke-RestMethod -Uri "$baseUrl/api/shipments" -Method Post -Body $shipmentBody -ContentType "application/json"
    Write-Host "[OK] Shipment created`n" -ForegroundColor Green

    # Step 3: Scan QR (deposit with token) to trigger OPEN command
    Write-Host "[Step 3] Scanning QR code (simulating courier deposit)..." -ForegroundColor White
    $depositBody = @{
        lockerId = $lockerId
        lockerToken = $token
        resi = $testResi
        weight = 0  # Weight will be measured by ESP32
    } | ConvertTo-Json

    $depositResponse = Invoke-RestMethod -Uri "$baseUrl/api/courier/deposit-token" -Method Post -Body $depositBody -ContentType "application/json"
    Write-Host "[OK] Locker OPEN command sent!`n" -ForegroundColor Green

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "✅ SUCCESS! Watch your backend logs for:" -ForegroundColor Green
    Write-Host "   [API IN] POST /api/locker/tesutoxx/weight/start" -ForegroundColor Yellow
    Write-Host "   [API IN] POST /api/locker/tesutoxx/weight/reading" -ForegroundColor Yellow
    Write-Host "   [API IN] POST /api/locker/tesutoxx/weight/finalize" -ForegroundColor Yellow
    Write-Host "========================================`n" -ForegroundColor Cyan

    Write-Host "ESP32 will now:" -ForegroundColor Cyan
    Write-Host "1. Poll /api/locker/tesutoxx/command and receive 'open'" -ForegroundColor White
    Write-Host "2. Open the locker door (relay ON)" -ForegroundColor White
    Write-Host "3. Start weight session: POST /weight/start" -ForegroundColor White
    Write-Host "4. Send weight readings every 2 seconds: POST /weight/reading" -ForegroundColor White
    Write-Host "5. After 20 seconds, close locker and send: POST /weight/finalize`n" -ForegroundColor White

} catch {
    Write-Host "`n[ERROR] Failed: $_" -ForegroundColor Red
    Write-Host "Response: $($_.ErrorDetails.Message)" -ForegroundColor Red
}
