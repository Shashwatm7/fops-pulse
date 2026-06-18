import { getDatabaseStats } from './db.js';

(async () => {
  try {
    const stats = await getDatabaseStats();
    console.log("SUCCESS:", JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error("ERROR:", err.message);
  }
  process.exit();
})();
