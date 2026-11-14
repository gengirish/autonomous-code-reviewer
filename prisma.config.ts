// Prisma 7 CLI config (migrate, generate, studio). Prisma 7 no longer loads .env itself,
// so DATABASE_URL comes from the process env, with the docker-compose URL as the dev default.
// Migrations should use a direct (non-pooled) connection: DIRECT_URL wins when set.
import { defineConfig } from "prisma/config";

const LOCAL_DATABASE_URL = "postgresql://acr:acr@localhost:5432/acr";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || LOCAL_DATABASE_URL,
  },
});
