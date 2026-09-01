-- Lot F4: monthly budget per client (Dashboard) — read before AccountBudget by the pacing.
ALTER TABLE "Dashboard" ADD COLUMN "monthlyBudget" DOUBLE PRECISION;
ALTER TABLE "Dashboard" ADD COLUMN "budgetCurrency" TEXT;
