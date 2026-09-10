// Run with: node generate-admin-hash.js <password>
// Prints a SQL INSERT statement you can run against your D1 database to
// create the first SUPER_ADMIN user, using the exact same PBKDF2 scheme
// the Worker uses at login time (see worker/src/auth.js).
const crypto = require("crypto");

const password = process.argv[2];
const username = process.argv[3] || "admin";
if (!password) {
  console.error("Usage: node generate-admin-hash.js <password> [username]");
  process.exit(1);
}

const ITERATIONS = 100000;
const salt = crypto.randomBytes(16);
const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const hash = `${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;

console.log(`INSERT INTO users (username, password_hash, role) VALUES ('${username}', '${hash}', 'SUPER_ADMIN');`);
