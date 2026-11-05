-- Client attached for the private bot only: dashboard hidden from them.
ALTER TABLE "DashboardMember" ADD COLUMN "dashboardHidden" BOOLEAN NOT NULL DEFAULT false;
