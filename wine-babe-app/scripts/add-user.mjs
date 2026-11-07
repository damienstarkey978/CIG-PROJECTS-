// Usage: node scripts/add-user.mjs <username> <password>
// Prints a line to paste into USERS in lib/auth.mjs.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../lib/auth.mjs";

const [name, password] = process.argv.slice(2);
if (!name || !password) { console.error("Usage: node scripts/add-user.mjs <username> <password>"); process.exit(1); }
const salt = randomBytes(16).toString("hex");
const hash = await hashPassword(password, salt);
console.log(`  ${name.toLowerCase()}: { name: ${JSON.stringify(name)}, salt: "${salt}", hash: "${hash}" },`);
