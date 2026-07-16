# PayDesk Backend AI Context

## Purpose

This repository is the PayDesk API server. It is a NestJS backend backed by Prisma and a relational database. It owns authentication, store access checks, product setup, products, inventory logs, billing, transactions, dashboards, customers, registers, and permissions.

## Important Rules For AI Agents

- Keep store scoping and authorization on the backend. Hiding frontend controls is not enough.
- Reuse `PosAccessService.ensureStoreAccess(...)` for authenticated store permission checks.
- Reuse `PrismaService`; do not introduce a second database access layer.
- Extend existing modules/controllers/services before adding parallel APIs for the same domain.
- Product and setup ownership currently lives mostly in `src/product/product.service.ts` and related controllers.
- Treat Prisma migrations as source-controlled artifacts. Do not edit an applied migration casually.

## Tech Stack

- NestJS 11
- TypeScript
- Prisma 5
- Jest
- JWT authentication
- Stripe billing integration
- ESLint and Prettier

## Common Commands

```bash
npx prisma format
npx prisma generate
npx prisma validate
npx prisma migrate dev --name <migration_name>
npx prisma migrate deploy
npm run lint
npm run build
npm test -- --runInBand
```

The `npm run lint` script runs ESLint with `--fix`, so it may modify files.

## Source Map

- `prisma/schema.prisma` - Database schema.
- `prisma/migrations/` - SQL migrations.
- `src/app.module.ts` - Root Nest module.
- `src/prisma.service.ts` - Shared Prisma client service.
- `src/common/pos-access.service.ts` - Store authorization and permission checks.
- `src/auth/` - Authentication and JWT strategy.
- `src/product/` - Products, departments, taxes, price groups, inventory logs, and product setup.
- `src/store/` - Store management.
- `src/permissions/` - Role and permission behavior.
- `src/billing/` - Stripe and subscription workflows.

## Price Groups Domain

The current price-group implementation extends the existing `PriceGroup` Prisma model instead of adding a second model.

Key files:

- `prisma/schema.prisma`
- `prisma/migrations/20260716120000_add_price_group_default_price_and_mismatch_cache/migration.sql`
- `src/product/store-price-groups.controller.ts`
- `src/product/price-group-mismatch-refresh.service.ts`
- `src/product/product.service.ts`
- `src/product/product.module.ts`

Store-scoped routes:

- `GET /stores/:storeId/price-groups`
- `POST /stores/:storeId/price-groups`
- `GET /stores/:storeId/price-groups/:priceGroupId`
- `PATCH /stores/:storeId/price-groups/:priceGroupId`
- `GET /stores/:storeId/price-groups/:priceGroupId/products`

Legacy active-only route retained for existing clients:

- `GET /product/price-group/store/:storeId`

## Mismatch Count Rule

A product is mismatched when it remains assigned to the price group and its `unitRetail`, rounded to cents, differs from the price group's `defaultUnitRetail`, rounded to cents. Both active and inactive assigned products are counted because the card count represents items still in the group.

`PriceGroup.mismatchedItemCount` and `PriceGroup.mismatchCountUpdatedAt` are cached. Recounts happen after relevant product or price-group writes and through `PriceGroupMismatchRefreshService` every 10 minutes.

## Scheduling Note

The mismatch refresh is an in-process Nest provider using a 10-minute interval. In multi-instance deployments it can run on every instance. The recount logic is centralized in `ProductService` so it can later move to Render cron, a queue worker, or database scheduling.
