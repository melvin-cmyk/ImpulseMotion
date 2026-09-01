-- AccountSetting: currency becomes nullable with no default (unknown ≠ EUR),
-- plus timezone and conversionEvent from the account profile.
-- AlterTable
ALTER TABLE "AccountSetting" ADD COLUMN     "conversionEvent" TEXT DEFAULT 'purchase',
ADD COLUMN     "timezone" TEXT,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "currency" DROP DEFAULT;
