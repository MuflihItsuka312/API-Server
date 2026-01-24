// Fix duplicate locker documents in MongoDB
require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/smartlocker";

async function fixDuplicateLockers() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const Locker = mongoose.model('Locker', new mongoose.Schema({}, { strict: false, collection: 'lockers' }));

    // Find all lockers
    const allLockers = await Locker.find({});
    console.log(`Found ${allLockers.length} total locker documents`);

    // Group by lockerId
    const groupedByLockerId = {};
    for (const locker of allLockers) {
      const id = locker.lockerId;
      if (!groupedByLockerId[id]) {
        groupedByLockerId[id] = [];
      }
      groupedByLockerId[id].push(locker);
    }

    // Find duplicates
    for (const [lockerId, lockers] of Object.entries(groupedByLockerId)) {
      if (lockers.length > 1) {
        console.log(`\n🔍 Found ${lockers.length} duplicate documents for lockerId: ${lockerId}`);
        
        // Keep the first one (most recent heartbeat)
        lockers.sort((a, b) => {
          const aTime = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
          const bTime = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
          return bTime - aTime;
        });

        const keepLocker = lockers[0];
        const deleteLockers = lockers.slice(1);

        // Merge pendingResi from all duplicates
        const allPendingResi = new Set(keepLocker.pendingResi || []);
        const allCourierHistory = [...(keepLocker.courierHistory || [])];

        for (const dupe of deleteLockers) {
          // Merge pendingResi
          if (dupe.pendingResi) {
            dupe.pendingResi.forEach(r => allPendingResi.add(r));
          }
          // Merge courierHistory
          if (dupe.courierHistory) {
            allCourierHistory.push(...dupe.courierHistory);
          }
        }

        // Update the keeper with merged data
        keepLocker.pendingResi = Array.from(allPendingResi);
        keepLocker.courierHistory = allCourierHistory;
        await keepLocker.save();

        console.log(`✅ Kept locker document: ${keepLocker._id}`);
        console.log(`   - Merged pendingResi: ${keepLocker.pendingResi.length} items`);
        console.log(`   - Merged courierHistory: ${keepLocker.courierHistory.length} items`);

        // Delete duplicates
        for (const dupe of deleteLockers) {
          await Locker.deleteOne({ _id: dupe._id });
          console.log(`❌ Deleted duplicate: ${dupe._id}`);
        }
      }
    }

    console.log("\n✅ Cleanup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

fixDuplicateLockers();
