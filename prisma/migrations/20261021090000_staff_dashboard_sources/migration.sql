-- Sources cochées par le consultant sur un dashboard du staff (plateformes + comptes), données au copilote
ALTER TABLE "StaffDashboard" ADD COLUMN "sourcesJson" TEXT NOT NULL DEFAULT '[]';
