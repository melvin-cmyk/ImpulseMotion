#!/usr/bin/env node
/**
 * Seed / upgrade an admin user for ImpulseMotion.
 *
 * Usage:
 *   node scripts/seed-admin.mjs <email> [password]
 *
 * If password is omitted, a random one is generated and printed.
 * Existing users with the same email are promoted to role=admin and get
 * their password updated.
 *
 * Requires DATABASE_URL in the env.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

function randomPassword(len = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function main() {
  const [, , emailArg, passwordArg] = process.argv;
  if (!emailArg) {
    console.error("Usage: node scripts/seed-admin.mjs <email> [password]");
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const password = passwordArg || randomPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  const prisma = new PrismaClient();

  const existing = await prisma.user.findUnique({ where: { email } });
  const user = existing
    ? await prisma.user.update({
        where: { email },
        data: { role: "admin", passwordHash },
      })
    : await prisma.user.create({
        data: { email, role: "admin", passwordHash },
      });

  await prisma.$disconnect();

  console.log(`✓ ${existing ? "Updated" : "Created"} admin: ${user.email}`);
  if (!passwordArg) {
    console.log(`  Password: ${password}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
