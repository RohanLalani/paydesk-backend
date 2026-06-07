require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function money(value) {
  return Number(Number(value).toFixed(2));
}

async function main() {
  const targetStoreId = process.env.STORE_ID;

  const store = targetStoreId
    ? await prisma.store.findUnique({
        where: { id: targetStoreId },
        include: { owner: true },
      })
    : await prisma.store.findFirst({
        where: { isActive: true },
        include: { owner: true },
        orderBy: { createdAt: "desc" },
      });

  if (!store) {
    throw new Error("No active store found. Create a store first or set STORE_ID.");
  }

  const staff = await prisma.staff.findUnique({
    where: { id: store.owner.staffId },
  });

  if (!staff) {
    throw new Error("No staff account found for store owner.");
  }

  const department = await prisma.department.upsert({
    where: {
      storeId_name: {
        storeId: store.id,
        name: "Demo Beverages",
      },
    },
    update: {},
    create: {
      storeId: store.id,
      name: "Demo Beverages",
      defaultAllowEbt: false,
    },
  });

  const priceGroup = await prisma.priceGroup.upsert({
    where: {
      storeId_name: {
        storeId: store.id,
        name: "Demo Default",
      },
    },
    update: {},
    create: {
      storeId: store.id,
      name: "Demo Default",
      description: "Default demo pricing",
    },
  });

  const category = await prisma.productCategory.upsert({
    where: {
      storeId_name: {
        storeId: store.id,
        name: "Demo Drinks & Snacks",
      },
    },
    update: {},
    create: {
      storeId: store.id,
      name: "Demo Drinks & Snacks",
      brand: "PayDesk Demo",
      description: "Demo category for dashboard testing",
    },
  });

  const tax = await prisma.tax.upsert({
    where: {
      storeId_name: {
        storeId: store.id,
        name: "Demo Sales Tax",
      },
    },
    update: {
      rate: 0.0825,
    },
    create: {
      storeId: store.id,
      name: "Demo Sales Tax",
      rate: 0.0825,
    },
  });

  const productsData = [
    { barcode: `DEMO-${store.id.slice(0, 6)}-100001`, name: "Bottled Water 500ml", price: 1.49, qty: 8 },
    { barcode: `DEMO-${store.id.slice(0, 6)}-100002`, name: "Coca-Cola 20oz", price: 2.49, qty: 36 },
    { barcode: `DEMO-${store.id.slice(0, 6)}-100003`, name: "Energy Drink", price: 3.49, qty: 4 },
    { barcode: `DEMO-${store.id.slice(0, 6)}-100004`, name: "Chips Classic", price: 1.99, qty: 25 },
    { barcode: `DEMO-${store.id.slice(0, 6)}-100005`, name: "Chocolate Bar", price: 1.79, qty: 2 },
    { barcode: `DEMO-${store.id.slice(0, 6)}-100006`, name: "Coffee Can", price: 2.99, qty: 14 },
  ];

  const products = [];

  for (const productData of productsData) {
    const product = await prisma.product.upsert({
      where: { barcode: productData.barcode },
      update: {
        name: productData.name,
        currentQuantity: productData.qty,
        unitRetail: productData.price,
        isActive: true,
      },
      create: {
        storeId: store.id,
        barcode: productData.barcode,
        name: productData.name,
        saleType: "piece",
        currentQuantity: productData.qty,
        unitRetail: productData.price,
        allowEbt: false,
        trackInventory: true,
        allowNegativeInventory: false,
        taxStyle: "post_discount",
        departmentId: department.id,
        priceGroupId: priceGroup.id,
        productCategoryId: category.id,
        taxId: tax.id,
      },
    });

    products.push(product);
  }

  const customers = [];

  for (let i = 1; i <= 5; i++) {
    const customerNumber = `DEMO-${store.id.slice(0, 6)}-CUST-${i}`;
    const phone = `40955510${String(i).padStart(2, "0")}`;

    const customer = await prisma.customer.upsert({
      where: { customerNumber },
      update: {
        phone,
        firstName: `Demo${i}`,
        lastName: "Customer",
        email: `demo${i}@customer.test`,
        rewardPoints: i * 20,
      },
      create: {
        customerNumber,
        phone,
        firstName: `Demo${i}`,
        lastName: "Customer",
        email: `demo${i}@customer.test`,
        rewardPoints: i * 20,
      },
    });

    await prisma.customerStore.upsert({
      where: {
        customerId_storeId: {
          customerId: customer.id,
          storeId: store.id,
        },
      },
      update: {},
      create: {
        customerId: customer.id,
        storeId: store.id,
        totalSpend: 0,
      },
    });

    customers.push(customer);
  }

  const now = Date.now();

  for (let i = 0; i < 24; i++) {
    const product = products[i % products.length];
    const quantity = (i % 3) + 1;
    const subtotal = money(Number(product.unitRetail) * quantity);
    const taxTotal = money(subtotal * 0.0825);
    const total = money(subtotal + taxTotal);
    const createdAt = new Date(now - i * 60 * 60 * 1000);
    const receiptNumber = `DEMO-${store.id.slice(0, 6)}-${now}-${i}`;

    const transaction = await prisma.transaction.create({
      data: {
        storeId: store.id,
        staffId: staff.id,
        customerId: customers[i % customers.length].id,
        subtotal,
        discountTotal: 0,
        taxTotal,
        total,
        paymentMethod: i % 2 === 0 ? "card" : "cash",
        paymentStatus: "paid",
        transactionStatus: "completed",
        receiptNumber,
        createdAt,
        items: {
          create: [
            {
              productId: product.id,
              nameSnapshot: product.name,
              barcodeSnapshot: product.barcode,
              quantity,
              unitPrice: product.unitRetail,
              lineSubtotal: subtotal,
              discountAmount: 0,
              taxAmount: taxTotal,
              lineTotal: total,
              taxStyle: product.taxStyle,
            },
          ],
        },
        receipt: {
          create: {
            receiptNumber,
            receiptData: {
              demo: true,
              receiptNumber,
              storeId: store.id,
              storeName: store.name,
              createdAt,
              subtotal,
              taxTotal,
              total,
              paymentMethod: i % 2 === 0 ? "card" : "cash",
              items: [
                {
                  name: product.name,
                  barcode: product.barcode,
                  quantity,
                  unitPrice: product.unitRetail,
                  lineTotal: total,
                },
              ],
            },
          },
        },
      },
    });

    await prisma.customerPurchaseHistory.create({
      data: {
        customerId: customers[i % customers.length].id,
        storeId: store.id,
        transactionId: transaction.id,
        totalSpend: total,
        purchasedAt: createdAt,
      },
    });

    await prisma.inventoryLog.create({
      data: {
        storeId: store.id,
        productId: product.id,
        performedByStaffId: staff.id,
        actionType: "sale",
        quantityBefore: product.currentQuantity,
        quantityChanged: -quantity,
        quantityAfter: product.currentQuantity - quantity,
        reason: "Demo dashboard sale",
        referenceType: "transaction",
        referenceId: transaction.id,
      },
    });
  }

  console.log("Demo dashboard data added successfully.");
  console.log("Store:", store.name);
  console.log("Store ID:", store.id);
  console.log("Products:", products.length);
  console.log("Customers:", customers.length);
  console.log("Transactions:", 24);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
