import { defineConfig } from 'prisma/config';

// The Prisma CLI for the PostgreSQL schema, for authoring only (`prisma generate`, `prisma
// migrate diff`). The API applies the migrations itself (persistence/database/migrator.ts),
// never the CLI. The schema engine wants a datasource even for a diff that never connects; this
// one is never opened.
export default defineConfig({
  schema: './schema.prisma',
  migrations: { path: './migrations' },
  datasource: { url: 'postgresql://unused@127.0.0.1:1/unused' },
});
