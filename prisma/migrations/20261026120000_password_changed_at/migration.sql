-- Sessions issued before a password change are refused (auth.ts).
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
