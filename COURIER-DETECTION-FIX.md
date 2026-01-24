# Courier Detection Test Report

## Test Date: January 21, 2026

### Detection Logic Improvements

**Problem Fixed:**
- JX8009962760 was being detected as JNE ❌
- Should be detected as J&T Express (JNT) ✅

**Solution Implemented:**
HIGH CONFIDENCE mode - When resi matches a strong pattern, ONLY try that specific courier (no fallbacks)

### High Confidence Patterns (Strict Mode)

| Pattern | Courier | Example | Regex |
|---------|---------|---------|-------|
| JT + digits | J&T Express | JT1234567890123 | `^(JT\|JX)\d{10,14}$` |
| JX + digits | J&T Express | JX8009962760 | `^(JT\|JX)\d{10,14}$` |
| JNE + alphanumeric | JNE Express | JNEA1234567890 | `^(JNE\|CGK)[A-Z0-9]{7,12}$` |
| CGK + alphanumeric | JNE Express | CGK123456789 | `^(JNE\|CGK)[A-Z0-9]{7,12}$` |
| Exactly 12 digits | SiCepat | 123456789012 | `^\d{12}$` |
| NLIDAP + digits | Ninja Express | NLIDAP12345678 | `^(NLIDAP\|NV)\d{8,12}$` |
| NV + digits | Ninja Express | NV12345678 | `^(NLIDAP\|NV)\d{8,12}$` |
| RR + 9 digits + ID | POS Indonesia | RR123456789ID | `^RR\d{9}ID$` |
| TSA + alphanumeric | AnterAja | TSA1234567890 | `^TSA[A-Z0-9]{7,12}$` |

### How It Works Now

#### Before (Unreliable):
1. Detect JX8009962760 as J&T ✓
2. Try J&T API → not found
3. Try JNE API → found (but WRONG courier!)
4. Accept JNE result ❌

#### After (Reliable):
1. Detect JX8009962760 as J&T with HIGH CONFIDENCE ✓
2. Try ONLY J&T API (strict mode)
3. If not found → reject (don't try other couriers)
4. Prevents false positives ✅

### Testing Commands

```powershell
# Test J&T detection (JX prefix)
curl.exe "http://192.168.0.56:3000/api/customer/track/JX8009962760"
# Should return: courierType: "jnt"

# Test J&T detection (JT prefix)  
curl.exe "http://192.168.0.56:3000/api/customer/track/JT1234567890123"
# Should return: courierType: "jnt"

# Test JNE detection
curl.exe "http://192.168.0.56:3000/api/customer/track/JNEA1234567890"
# Should return: courierType: "jne"

# Test SiCepat detection (12 digits)
curl.exe "http://192.168.0.56:3000/api/customer/track/123456789012"
# Should return: courierType: "sicepat"
```

### Benefits

✅ **More Accurate** - Strong patterns only try one courier
✅ **Faster** - No wasted API calls to wrong couriers  
✅ **Prevents Mix-ups** - JX won't be detected as JNE anymore
✅ **Fallback Still Works** - Uncertain patterns still try multiple couriers

### Low Confidence Patterns (Fallback Mode)

When resi doesn't match any strong pattern:
- **13-14 pure digits**: Try AnterAja → SiCepat → POS → J&T → JNE → Ninja
- **Letter prefix + numbers**: Try J&T → JNE → AnterAja → Ninja → SiCepat → POS
- **Unknown format**: Try JNE → J&T → AnterAja → SiCepat → Ninja → POS

### Verification

Check backend logs for:
```
[RESI DETECT] JX8009962760 HIGH CONFIDENCE: JNT
[RESI DETECT] Using STRICT mode - only trying detected courier
[BINDERBYTE] Validating JX8009962760 - optimized order: jnt...
```

This confirms the system is using strict mode for high confidence patterns.

### Database Update

If you have existing resi in database with wrong courier type, you can:

1. **Revalidate individual resi:**
   ```powershell
   curl.exe -X POST "http://192.168.0.56:3000/api/manual-resi/revalidate/JX8009962760"
   ```

2. **Or delete and re-add:**
   ```powershell
   # Delete old entry
   curl.exe -X DELETE "http://192.168.0.56:3000/api/manual-resi/JX8009962760"
   
   # Re-add (will use new detection)
   curl.exe -X POST "http://192.168.0.56:3000/api/customer/manual-resi" \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"resi":"JX8009962760"}'
   ```

---

## Summary

**Issue:** JX8009962760 detected as JNE instead of J&T  
**Cause:** Fallback logic tried multiple couriers, accepted first match  
**Fix:** HIGH CONFIDENCE mode - strong patterns only try one courier  
**Result:** ✅ Reliable detection for well-known formats
