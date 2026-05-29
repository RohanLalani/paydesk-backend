const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

function nowStamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postJson(url, token, body) {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    status: response.status,
    ok: response.ok,
    ms: Date.now() - started,
    data,
  };
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

async function main() {
  loadEnv();

  const baseUrl = process.env.STRESS_BASE_URL ?? 'http://127.0.0.1:3000';
  const attemptsCount = Number(process.env.STRESS_ATTEMPTS ?? 80);
  const concurrency = Number(process.env.STRESS_CONCURRENCY ?? 40);
  const stock = Number(process.env.STRESS_STOCK ?? 25);
  const allowOverload = process.env.STRESS_ALLOW_OVERLOAD === '1';
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required for stress testing');
  }

  const runId = `stress-${nowStamp()}`;
  const prisma = new PrismaClient();
  let fixture = null;

  try {
    await cleanupStressFixtures(prisma);

    const owner = await prisma.owner.create({
      data: {
        email: `${runId}@example.com`,
        password: 'stress-only',
        name: 'Stress Owner',
        staff: {
          create: {
            email: `${runId}@example.com`,
            name: 'Stress Owner',
            role: 'owner',
            emailVerifiedAt: new Date(),
          },
        },
      },
      include: { staff: true },
    });

    const store = await prisma.store.create({
      data: {
        name: `Stress Store ${runId}`,
        address: 'Stress Test Address',
        ownerId: owner.id,
      },
    });

    const [department, priceGroup, productCategory, tax] = await Promise.all([
      prisma.department.create({
        data: {
          storeId: store.id,
          name: `Dept ${runId}`,
        },
      }),
      prisma.priceGroup.create({
        data: {
          storeId: store.id,
          name: `Price ${runId}`,
        },
      }),
      prisma.productCategory.create({
        data: {
          storeId: store.id,
          name: `Category ${runId}`,
        },
      }),
      prisma.tax.create({
        data: {
          storeId: store.id,
          name: `Tax ${runId}`,
          rate: 0.0825,
        },
      }),
    ]);

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        barcode: `stress-${nowStamp()}`,
        name: `Stress Product ${runId}`,
        saleType: 'piece',
        currentQuantity: stock,
        unitRetail: 1.99,
        allowEbt: true,
        trackInventory: true,
        allowNegativeInventory: false,
        taxStyle: 'post_discount',
        departmentId: department.id,
        priceGroupId: priceGroup.id,
        productCategoryId: productCategory.id,
        taxId: tax.id,
      },
    });
    fixture = {
      ownerId: owner.id,
      ownerStaffId: owner.staffId,
      storeId: store.id,
    };

    const token = jwt.sign(
      {
        accountId: owner.id,
        staffId: owner.staffId,
        role: 'owner',
        type: 'owner',
      },
      jwtSecret,
      { expiresIn: '10m' },
    );

    const checkoutUrl = `${baseUrl}/transaction/checkout`;
    const validateUrl = `${baseUrl}/transaction/cart/validate`;
    const body = {
      storeId: store.id,
      paymentMethod: 'cash',
      items: [{ productId: product.id, quantity: 1, discountAmount: 0 }],
    };

    const warmup = await postJson(validateUrl, token, {
      storeId: store.id,
      items: body.items,
    });

    if (!warmup.ok) {
      throw new Error(`Warmup validate failed: ${JSON.stringify(warmup)}`);
    }

    const started = Date.now();
    const attempts = Array.from({ length: attemptsCount }, (_, index) => index);
    const results = await withConcurrency(attempts, concurrency, () =>
      postJson(checkoutUrl, token, body),
    );
    const elapsedMs = Date.now() - started;
    const success = results.filter((result) => result.ok);
    const overloadFailures = results.filter((result) => result.status === 503);
    const clientFailures = results.filter(
      (result) => result.status >= 400 && result.status < 500,
    );
    const serverFailures = results.filter((result) => result.status >= 500);
    const unexpectedServerFailures = results.filter(
      (result) => result.status >= 500 && result.status !== 503,
    );
    const latencies = results.map((result) => result.ms).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const [
      finalProduct,
      transactionCount,
      itemCount,
      receiptCount,
      inventoryLogCount,
      duplicateReceipts,
    ] = await Promise.all([
      prisma.product.findUnique({ where: { id: product.id } }),
      prisma.transaction.count({ where: { storeId: store.id } }),
      prisma.transactionItem.count({
        where: { transaction: { storeId: store.id } },
      }),
      prisma.receipt.count({ where: { transaction: { storeId: store.id } } }),
      prisma.inventoryLog.count({
        where: {
          storeId: store.id,
          productId: product.id,
          actionType: 'sale',
          reason: 'sale',
        },
      }),
      prisma.transaction.groupBy({
        by: ['receiptNumber'],
        where: { storeId: store.id },
        _count: { receiptNumber: true },
        having: {
          receiptNumber: {
            _count: {
              gt: 1,
            },
          },
        },
      }),
    ]);

    const invariantErrors = [];

    if (!allowOverload && success.length !== stock) {
      invariantErrors.push(
        `expected ${stock} successful checkouts, got ${success.length}`,
      );
    }

    if (!allowOverload && clientFailures.length !== attemptsCount - stock) {
      invariantErrors.push(
        `expected ${attemptsCount - stock} client failures, got ${clientFailures.length}`,
      );
    }

    if (unexpectedServerFailures.length !== 0) {
      invariantErrors.push(
        `expected 0 unexpected server failures, got ${unexpectedServerFailures.length}`,
      );
    }

    if (!allowOverload && finalProduct?.currentQuantity !== 0) {
      invariantErrors.push(
        `expected final inventory 0, got ${finalProduct?.currentQuantity}`,
      );
    }

    if (transactionCount !== success.length) {
      invariantErrors.push(
        `expected transaction count ${success.length}, got ${transactionCount}`,
      );
    }

    if (itemCount !== success.length) {
      invariantErrors.push(
        `expected item count ${success.length}, got ${itemCount}`,
      );
    }

    if (receiptCount !== success.length) {
      invariantErrors.push(
        `expected receipt count ${success.length}, got ${receiptCount}`,
      );
    }

    if (inventoryLogCount !== success.length) {
      invariantErrors.push(
        `expected inventory log count ${success.length}, got ${inventoryLogCount}`,
      );
    }

    if (duplicateReceipts.length) {
      invariantErrors.push(
        `duplicate receipt numbers found: ${duplicateReceipts.length}`,
      );
    }

    const failureMessages = new Map();

    for (const failure of clientFailures) {
      const message =
        typeof failure.data?.message === 'string'
          ? failure.data.message
          : JSON.stringify(failure.data);
      failureMessages.set(message, (failureMessages.get(message) ?? 0) + 1);
    }

    const report = {
      runId,
      elapsedMs,
      attempts: results.length,
      concurrency,
      stock,
      success: success.length,
      clientFailures: clientFailures.length,
      overloadFailures: overloadFailures.length,
      serverFailures: serverFailures.length,
      unexpectedServerFailures: unexpectedServerFailures.length,
      latencyMs: { p50, p95, p99, max: latencies.at(-1) },
      finalInventory: finalProduct?.currentQuantity,
      transactionCount,
      itemCount,
      receiptCount,
      inventoryLogCount,
      duplicateReceiptGroups: duplicateReceipts.length,
      clientFailureMessages: Object.fromEntries(failureMessages),
      invariantErrors,
    };

    console.log(JSON.stringify(report, null, 2));

    if (invariantErrors.length) {
      process.exitCode = 1;
    }
  } finally {
    if (fixture) {
      await cleanupFixture(prisma, fixture).catch((error) => {
        console.error(
          `Cleanup failed: ${error instanceof Error ? error.message : error}`,
        );
      });
    }

    await prisma.$disconnect();
  }
}

async function cleanupStressFixtures(prisma) {
  const stores = await prisma.store.findMany({
    where: { name: { startsWith: 'Stress Store stress-' } },
    select: { id: true, ownerId: true, owner: { select: { staffId: true } } },
  });

  for (const store of stores) {
    await cleanupFixture(prisma, {
      storeId: store.id,
      ownerId: store.ownerId,
      ownerStaffId: store.owner.staffId,
    });
  }
}

async function cleanupFixture(prisma, fixture) {
  await prisma.receipt
    .deleteMany({ where: { transaction: { storeId: fixture.storeId } } })
    .catch(() => {});
  await prisma.transactionItem
    .deleteMany({ where: { transaction: { storeId: fixture.storeId } } })
    .catch(() => {});
  await prisma.transaction
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.inventoryLog
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.customerPurchaseHistory
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.customerStore
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.product
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.department
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.priceGroup
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.productCategory
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.tax
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.storeStaff
    .deleteMany({ where: { storeId: fixture.storeId } })
    .catch(() => {});
  await prisma.store.delete({ where: { id: fixture.storeId } }).catch(() => {});
  await prisma.emailVerificationToken
    .deleteMany({ where: { staffId: fixture.ownerStaffId } })
    .catch(() => {});
  await prisma.passwordResetToken
    .deleteMany({ where: { staffId: fixture.ownerStaffId } })
    .catch(() => {});
  await prisma.owner.delete({ where: { id: fixture.ownerId } }).catch(() => {});
  await prisma.staff
    .delete({ where: { id: fixture.ownerStaffId } })
    .catch(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
