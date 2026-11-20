# LiquiStock

Sistema POS **Offline-First**, multi-sucursal y multi-dispositivo (tablets, celulares y caja) para bares y cervecerías artesanales, construido con **Clean Architecture** en un monorepo TypeScript.

## Arquitectura del Monorepo

- `packages/domain`: Núcleo de dominio puro (0 dependencias externas), compartido entre el POS Offline (tablets) y el Backend:
  - Conversión exacta de unidades base (`ml`, `g`, `unit`) desde barriles (`L`), shots (`oz`) y botellas (`ml`).
  - Fórmula configurable de merma por espuma y purga de grifo (`calculatePourDeduction`).
  - Motor de recetas, combos mixtos y aliados (`explodePresentationSale`).
  - Evaluador de disponibilidad sincronizada con stock real y horarios de cierre de aliados (`evaluatePresentationAvailability`).
  - Motor de promociones extensible (`2x1`, `Happy Hour`, descuentos) (`evaluateLinePromotion`).
  - Guardias de crédito Lista Blanca / Lista Negra (`evaluateCreditRequest`) y Cierre de Caja parcial con deudas (`calculateCashShiftClosure`).
- `apps/api`: Backend **Fastify + PostgreSQL 16 + WebSockets** con libro mayor inmutable (`inventory_ledger` y `customer_credit_ledger`) y endpoint `/api/v1/sync/batch` idempotente.
- `apps/web`: PWA táctil **React 19 + Tailwind CSS v4 (paleta OKLCH nocturna)** + **Dexie.js (IndexedDB + Outbox)** con sincronización multi-tablet en tiempo real.

## Arranque Rápido

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev:api
pnpm dev:web
```

## Verificación

```bash
pnpm typecheck
pnpm test
pnpm build
```

