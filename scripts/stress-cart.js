const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

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

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function request(method, url, token, body) {
  const started = Date.now();
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
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

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is required for stress testing');

  const baseUrl = process.env.CART_STRESS_BASE_URL ?? 'http://127.0.0.1:3000';
  const concurrency = Number(process.env.CART_STRESS_CONCURRENCY ?? 1);
  const runId = `cart-stress-${nowStamp()}`;
  const prisma = new PrismaClient();
  const errors = [];
  let fixture = null;

  try {
    await cleanupStressFixtures(prisma);
    fixture = await seedFixture(prisma, runId, jwtSecret);
    const { ownerToken, managerToken, employeeToken } = fixture.tokens;
    const cartUrl = `${baseUrl}/cart`;

    const startResults = await withConcurrency(
      Array.from({ length: 20 }),
      concurrency,
      () =>
        request('POST', `${cartUrl}/start`, ownerToken, {
          storeId: fixture.store.id,
        }),
    );
    assert(
      startResults.every((result) => result.ok),
      'POST /cart/start should succeed for all start attempts',
      errors,
    );
    assert(
      startResults.every(
        (result) =>
          result.data?.items?.length === 0 &&
          result.data?.customer === null &&
          result.data?.totals?.grandTotal === 0,
      ),
      'POST /cart/start should return empty carts with zero totals',
      errors,
    );

    const mainCart = startResults[0].data;
    const addResult = await request(
      'POST',
      `${cartUrl}/${mainCart.id}/add-barcode`,
      ownerToken,
      {
        storeId: fixture.store.id,
        barcode: fixture.products.main.barcode,
        quantity: 2,
      },
    );
    assert(
      addResult.ok,
      'POST /cart/:cartId/add-barcode should succeed',
      errors,
    );
    assert(
      addResult.data?.items?.[0]?.quantity === 2,
      'add-barcode should add requested quantity',
      errors,
    );

    const getResult = await request(
      'GET',
      `${cartUrl}/${mainCart.id}`,
      ownerToken,
    );
    assert(getResult.ok, 'GET /cart/:cartId should succeed', errors);
    assert(
      getResult.data?.totals?.grandTotal > 0,
      'GET /cart/:cartId should return calculated totals',
      errors,
    );

    const itemId = getResult.data.items[0].id;
    const quantityResult = await request(
      'PATCH',
      `${cartUrl}/${mainCart.id}/item/${itemId}/quantity`,
      ownerToken,
      { quantity: 3 },
    );
    assert(
      quantityResult.ok,
      'PATCH /cart/:cartId/item/:itemId/quantity should succeed',
      errors,
    );
    assert(
      quantityResult.data?.items?.[0]?.quantity === 3,
      'quantity update should return updated quantity',
      errors,
    );

    const employeeOverride = await request(
      'PATCH',
      `${cartUrl}/${mainCart.id}/item/${itemId}/price-override`,
      employeeToken,
      { price: 1.25, reason: 'Employee should not be allowed' },
    );
    assert(
      employeeOverride.status === 403,
      'employee price override should return Forbidden',
      errors,
    );

    const overrideResult = await request(
      'PATCH',
      `${cartUrl}/${mainCart.id}/item/${itemId}/price-override`,
      managerToken,
      { price: 1.5, reason: 'Manager approved stress test' },
    );
    assert(
      overrideResult.ok,
      'manager PATCH /cart/:cartId/item/:itemId/price-override should succeed',
      errors,
    );
    assert(
      overrideResult.data?.items?.[0]?.unitPrice === 1.5 &&
        overrideResult.data?.items?.[0]?.priceOverrideReason,
      'price override should update unit price and reason',
      errors,
    );

    const customerResult = await request(
      'POST',
      `${cartUrl}/${mainCart.id}/customer/phone`,
      ownerToken,
      { phone: fixture.customer.phone },
    );
    assert(
      customerResult.ok,
      'POST /cart/:cartId/customer/phone should attach customer',
      errors,
    );
    assert(
      customerResult.data?.customer?.id === fixture.customer.id,
      'customer response should include attached customer',
      errors,
    );
    assert(
      customerResult.data?.totals?.loyaltyDiscountTotal > 0,
      'customer tier should apply loyalty discount',
      errors,
    );

    const notFoundCustomer = await request(
      'POST',
      `${cartUrl}/${mainCart.id}/customer/phone`,
      ownerToken,
      { phone: `999${fixture.customer.phone}`.slice(0, 10) },
    );
    assert(
      notFoundCustomer.status === 404,
      'unknown customer phone should return NotFound',
      errors,
    );

    const prepareResult = await request(
      'POST',
      `${cartUrl}/${mainCart.id}/prepare-payment`,
      ownerToken,
    );
    assert(
      prepareResult.ok,
      'POST /cart/:cartId/prepare-payment should succeed',
      errors,
    );
    assert(
      prepareResult.data?.status === 'ready_for_payment' &&
        prepareResult.data?.paymentStatus === 'ready_for_payment',
      'prepare-payment should mark cart ready',
      errors,
    );

    const addAfterPrepare = await request(
      'POST',
      `${cartUrl}/${mainCart.id}/add-barcode`,
      ownerToken,
      {
        storeId: fixture.store.id,
        barcode: fixture.products.main.barcode,
        quantity: 1,
      },
    );
    assert(
      addAfterPrepare.status === 400,
      'prepared cart should reject further add-barcode operations',
      errors,
    );

    const stockCart = await request('POST', `${cartUrl}/start`, ownerToken, {
      storeId: fixture.store.id,
    });
    const stockAttempts = await withConcurrency(
      Array.from({ length: 12 }),
      concurrency,
      () =>
        request(
          'POST',
          `${cartUrl}/${stockCart.data.id}/add-barcode`,
          ownerToken,
          {
            storeId: fixture.store.id,
            barcode: fixture.products.limited.barcode,
            quantity: 1,
          },
        ),
    );
    const stockSuccess = stockAttempts.filter((result) => result.ok).length;
    const stockFailures = stockAttempts.filter(
      (result) => result.status === 400,
    ).length;
    assert(
      stockSuccess === 5,
      `limited stock cart should accept 5 adds, got ${stockSuccess}`,
      errors,
    );
    assert(
      stockFailures === 7,
      `limited stock cart should reject 7 adds, got ${stockFailures}`,
      errors,
    );

    const preparedCarts = await withConcurrency(
      startResults.slice(1, 11),
      concurrency,
      async (startResult) => {
        const cart = startResult.data;
        const add = await request(
          'POST',
          `${cartUrl}/${cart.id}/add-barcode`,
          ownerToken,
          {
            storeId: fixture.store.id,
            barcode: fixture.products.main.barcode,
            quantity: 1,
          },
        );
        if (!add.ok) return add;

        return request(
          'POST',
          `${cartUrl}/${cart.id}/prepare-payment`,
          ownerToken,
        );
      },
    );
    assert(
      preparedCarts.every((result) => result.ok),
      'repeated prepare-payment calls on separate carts should succeed',
      errors,
    );

    const [cartCount, itemCount, readyCount] = await Promise.all([
      prisma.cart.count({ where: { storeId: fixture.store.id } }),
      prisma.cartItem.count({ where: { cart: { storeId: fixture.store.id } } }),
      prisma.cart.count({
        where: { storeId: fixture.store.id, status: 'ready_for_payment' },
      }),
    ]);

    assert(
      cartCount >= 21,
      `expected at least 21 carts, got ${cartCount}`,
      errors,
    );
    assert(
      itemCount >= 12,
      `expected at least 12 cart items, got ${itemCount}`,
      errors,
    );
    assert(
      readyCount >= 11,
      `expected at least 11 ready carts, got ${readyCount}`,
      errors,
    );

    const allResults = [
      ...startResults,
      addResult,
      getResult,
      quantityResult,
      employeeOverride,
      overrideResult,
      customerResult,
      notFoundCustomer,
      prepareResult,
      addAfterPrepare,
      stockCart,
      ...stockAttempts,
      ...preparedCarts,
    ];
    const latencies = allResults
      .map((result) => result.ms)
      .sort((a, b) => a - b);
    const report = {
      runId,
      concurrency,
      requests: allResults.length,
      statusCounts: allResults.reduce((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        return counts;
      }, {}),
      latencyMs: {
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.floor(latencies.length * 0.95)],
        max: latencies.at(-1),
      },
      cartCount,
      itemCount,
      readyCount,
      errors,
    };

    console.log(JSON.stringify(report, null, 2));

    if (errors.length) {
      process.exitCode = 1;
    }
  } finally {
    await cleanupStressFixtures(prisma).catch((error) => {
      console.error(
        `Cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    });
    await prisma.$disconnect();
  }
}

async function seedFixture(prisma, runId, jwtSecret) {
  const owner = await prisma.owner.create({
    data: {
      email: `${runId}@example.com`,
      password: 'stress-only',
      name: 'Cart Stress Owner',
      staff: {
        create: {
          email: `${runId}@example.com`,
          name: 'Cart Stress Owner',
          role: 'owner',
          emailVerifiedAt: new Date(),
        },
      },
    },
    include: { staff: true },
  });
  const manager = await prisma.manager.create({
    data: {
      email: `${runId}.manager@example.com`,
      password: 'stress-only',
      name: 'Cart Stress Manager',
      staff: {
        create: {
          email: `${runId}.manager@example.com`,
          name: 'Cart Stress Manager',
          role: 'manager',
          emailVerifiedAt: new Date(),
        },
      },
    },
    include: { staff: true },
  });
  const employee = await prisma.employee.create({
    data: {
      email: `${runId}.employee@example.com`,
      password: 'stress-only',
      name: 'Cart Stress Employee',
      isActive: true,
      staff: {
        create: {
          email: `${runId}.employee@example.com`,
          name: 'Cart Stress Employee',
          role: 'employee',
          emailVerifiedAt: new Date(),
        },
      },
    },
    include: { staff: true },
  });
  const store = await prisma.store.create({
    data: {
      name: `Cart Stress Store ${runId}`,
      address: 'Cart Stress Address',
      ownerId: owner.id,
    },
  });
  await prisma.storeStaff.createMany({
    data: [
      {
        storeId: store.id,
        staffId: manager.staffId,
        role: 'manager',
        managerId: manager.id,
      },
      {
        storeId: store.id,
        staffId: employee.staffId,
        role: 'employee',
        employeeId: employee.id,
      },
    ],
  });

  const [department, priceGroup, productCategory, tax] = await Promise.all([
    prisma.department.create({
      data: { storeId: store.id, name: `Cart Stress Dept ${runId}` },
    }),
    prisma.priceGroup.create({
      data: { storeId: store.id, name: `Cart Stress Price ${runId}` },
    }),
    prisma.productCategory.create({
      data: { storeId: store.id, name: `Cart Stress Category ${runId}` },
    }),
    prisma.tax.create({
      data: { storeId: store.id, name: `Cart Stress Tax ${runId}`, rate: 0.1 },
    }),
  ]);
  const tier = await prisma.customerTier.create({
    data: {
      name: `Cart Stress Tier ${runId}`,
      discountModel: 'ORDER_PERCENTAGE',
      discountValue: 10,
      ownerId: owner.id,
      storeId: store.id,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      customerNumber: `${Date.now()}`.padEnd(18, '0').slice(0, 18),
      firstName: 'Cart',
      lastName: 'Customer',
      phone: `${Math.floor(1000000000 + Math.random() * 8999999999)}`,
      stores: {
        create: {
          storeId: store.id,
          tier: tier.name,
          currentTierId: tier.id,
        },
      },
    },
  });
  const productBase = {
    storeId: store.id,
    saleType: 'piece',
    unitRetail: 2,
    allowEbt: true,
    trackInventory: true,
    allowNegativeInventory: false,
    taxStyle: 'post_discount',
    departmentId: department.id,
    priceGroupId: priceGroup.id,
    productCategoryId: productCategory.id,
    taxId: tax.id,
  };
  const mainProduct = await prisma.product.create({
    data: {
      ...productBase,
      barcode: `cart-main-${nowStamp()}`,
      name: `Cart Stress Main ${runId}`,
      currentQuantity: 500,
    },
  });
  const limitedProduct = await prisma.product.create({
    data: {
      ...productBase,
      barcode: `cart-limited-${nowStamp()}`,
      name: `Cart Stress Limited ${runId}`,
      currentQuantity: 5,
    },
  });

  return {
    owner,
    manager,
    employee,
    store,
    customer,
    products: {
      main: mainProduct,
      limited: limitedProduct,
    },
    tokens: {
      ownerToken: signToken(jwtSecret, owner.id, owner.staffId, 'owner'),
      managerToken: signToken(
        jwtSecret,
        manager.id,
        manager.staffId,
        'manager',
      ),
      employeeToken: signToken(
        jwtSecret,
        employee.id,
        employee.staffId,
        'employee',
      ),
    },
  };
}

function signToken(jwtSecret, accountId, staffId, type) {
  return jwt.sign({ accountId, staffId, role: type, type }, jwtSecret, {
    expiresIn: '10m',
  });
}

async function cleanupStressFixtures(prisma) {
  const stores = await prisma.store.findMany({
    where: { name: { startsWith: 'Cart Stress Store cart-stress-' } },
    select: { id: true, ownerId: true },
  });

  for (const store of stores) {
    const staffIds = (
      await prisma.storeStaff.findMany({
        where: { storeId: store.id },
        select: { staffId: true },
      })
    ).map((staff) => staff.staffId);
    const owner = await prisma.owner.findUnique({
      where: { id: store.ownerId },
      select: { staffId: true },
    });

    if (owner) staffIds.push(owner.staffId);

    await prisma.cartItem.deleteMany({
      where: { cart: { storeId: store.id } },
    });
    await prisma.cart.deleteMany({ where: { storeId: store.id } });
    await prisma.customerPurchaseHistory.deleteMany({
      where: { storeId: store.id },
    });
    await prisma.customerStore.deleteMany({ where: { storeId: store.id } });
    await prisma.customer.deleteMany({
      where: {
        firstName: 'Cart',
        lastName: 'Customer',
        stores: { none: {} },
      },
    });
    await prisma.product.deleteMany({ where: { storeId: store.id } });
    await prisma.customerTierRule.deleteMany({ where: { storeId: store.id } });
    await prisma.customerTier.deleteMany({ where: { storeId: store.id } });
    await prisma.department.deleteMany({ where: { storeId: store.id } });
    await prisma.priceGroup.deleteMany({ where: { storeId: store.id } });
    await prisma.productCategory.deleteMany({ where: { storeId: store.id } });
    await prisma.tax.deleteMany({ where: { storeId: store.id } });
    await prisma.storeStaff.deleteMany({ where: { storeId: store.id } });
    await prisma.store.delete({ where: { id: store.id } }).catch(() => {});
    await prisma.manager.deleteMany({
      where: { staffId: { in: staffIds } },
    });
    await prisma.employee.deleteMany({
      where: { staffId: { in: staffIds } },
    });
    await prisma.owner.delete({ where: { id: store.ownerId } }).catch(() => {});
    await prisma.emailVerificationToken.deleteMany({
      where: { staffId: { in: staffIds } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { staffId: { in: staffIds } },
    });
    await prisma.staff.deleteMany({ where: { id: { in: staffIds } } });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
