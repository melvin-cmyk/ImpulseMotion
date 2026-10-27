-- Design editor kind: figcraft (layout, shared live file) | photocraft (image retouching, workspace files)
ALTER TABLE "DesignFile" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'figcraft';
