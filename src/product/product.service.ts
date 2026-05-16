import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductService {

  constructor(
    private prisma: PrismaService,
  ) {}

  //
  // CREATE PRODUCT GROUP
  //
  async createGroup(
    ownerId: string,

    data: {
      storeId: string;
      name: string;
    },
  ) {

    // ✅ VERIFY STORE OWNERSHIP
    const store =
      await this.prisma.store.findFirst({
        where: {
          id: data.storeId,
          ownerId,
        },
      });

    if (!store) {
      return {
        error:
          'Store not found or unauthorized',
      };
    }

    const existingGroup =
      await this.prisma.productGroup.findFirst({
        where: {
          storeId: data.storeId,
          name: data.name,
        },
      });

    if (existingGroup) {
      return {
        error:
          'Group already exists',
      };
    }

    const group =
      await this.prisma.productGroup.create({
        data: {
          name: data.name,
          storeId: data.storeId,
        },
      });

    return {
      message: 'Group created',
      group,
    };
  }

//
// CREATE DEPARTMENT
//
async createDepartment(
  ownerId: string,

  data: {
    storeId: string;
    name: string;
  },
) {

  // ✅ VERIFY STORE OWNERSHIP
  const store =
    await this.prisma.store.findFirst({
      where: {
        id: data.storeId,
        ownerId,
      },
    });

  if (!store) {
    return {
      error:
        'Store not found or unauthorized',
    };
  }

  // ✅ UNIQUE NAME PER STORE
  const existingDepartment =
    await this.prisma.department.findFirst({
      where: {
        storeId: data.storeId,
        name: data.name,
      },
    });

  if (existingDepartment) {
    return {
      error:
        'Department already exists',
    };
  }

  const department =
    await this.prisma.department.create({
      data: {
        name: data.name,
        storeId: data.storeId,
      },
    });

  return {
    message: 'Department created',
    department,
  };
}

//
// GET STORE DEPARTMENTS
//
async getDepartments(
  ownerId: string,
  storeId: string,
) {

  // ✅ VERIFY STORE OWNERSHIP
  const store =
    await this.prisma.store.findFirst({
      where: {
        id: storeId,
        ownerId,
      },
    });

  if (!store) {
    return {
      error:
        'Store not found or unauthorized',
    };
  }

  return this.prisma.department.findMany({
    where: {
      storeId,
    },

    orderBy: {
      name: 'asc',
    },
  });
}

  //
  // CREATE TAX
  //
  async createTax(
    ownerId: string,

    data: {
      name: string;
      rate: number;
    },
  ) {

    const tax =
      await this.prisma.tax.create({
        data: {
          name: data.name,
          rate: data.rate,
        },
      });

    return {
      message: 'Tax created',
      tax,
    };
  }

  //
  // CREATE PRODUCT
  //
  async createProduct(
    ownerId: string,

    data: any,
  ) {

    // ✅ VERIFY STORE OWNERSHIP
    const store =
      await this.prisma.store.findFirst({
        where: {
          id: data.storeId,
          ownerId,
        },
      });

    if (!store) {
      return {
        error:
          'Store not found or unauthorized',
      };
    }

    // ✅ BARCODE UNIQUE
    const existingProduct =
      await this.prisma.product.findUnique({
        where: {
          barcode: data.barcode,
        },
      });

    if (existingProduct) {
      return {
        error:
          'Barcode already exists',
      };
    }

    const product =
      await this.prisma.product.create({
        data: {
          name: data.name,
          barcode: data.barcode,

          price: data.price,

          stock: data.stock || 0,

          costPrice: data.costPrice,

          caseCost: data.caseCost,
          caseRebate: data.caseRebate,
          unitsPerCase: data.unitsPerCase,

          departmentId: data.departmentId,
          category: data.category,
          nacsCode: data.nacsCode,

          saleType: data.saleType,
          size: data.size,

          caseBarcode: data.caseBarcode,

          minAge: data.minAge,

          storeId: data.storeId,

          groupId: data.groupId,

          taxId: data.taxId,
        },
      });
    console.log(product);
    return {
      message: 'Product created',
      product,
    };
  }

  //
  // BARCODE LOOKUP
  //
  async barcodeLookup(
    storeId: string,
    barcode: string,
  ) {

    const product =
      await this.prisma.product.findFirst({
        where: {
          storeId,
          barcode,
        },

        include: {
          group: true,
          tax: true,
        },
      });

    if (!product) {
      return {
        error: 'Product not found',
      };
    }

    return product;
  }

  //
  // PRODUCT SEARCH
  //
  async searchProducts(
    storeId: string,
    query: string,
  ) {

    return this.prisma.product.findMany({
      where: {
        storeId,

        OR: [
          {
            name: {
              contains: query,
              mode: 'insensitive',
            },
          },

          {
            barcode: {
              contains: query,
            },
          },
        ],
      },

      take: 25,

      orderBy: {
        name: 'asc',
      },
    });
  }

  //
  // INVENTORY ADJUSTMENT
  //
  async adjustInventory(
    user: any,

    data: {
      productId: string;
      change: number;
      reason: string;
    },
  ) {

    const product =
      await this.prisma.product.findUnique({
        where: {
          id: data.productId,
        },
      });

    if (!product) {
      return {
        error: 'Product not found',
      };
    }

    const updatedProduct =
      await this.prisma.product.update({
        where: {
          id: data.productId,
        },

        data: {
          stock: {
            increment: data.change,
          },
        },
      });

    await this.prisma.inventoryLog.create({
      data: {
        productId: product.id,
        storeId: product.storeId,

        ownerId:
          user.type === 'owner'
            ? user.ownerId
            : null,

        employeeId:
          user.type === 'employee'
            ? user.employeeId
            : null,

        change: data.change,
        reason: data.reason,
      },
    });

    return {
      message: 'Inventory updated',
      product: updatedProduct,
    };
  }

//
// RECEIVE CASE INVENTORY
//
async receiveCaseInventory(
  user: any,

  data: {
    productId: string;
    cases: number;
    reason?: string;
  },
) {

  const product =
    await this.prisma.product.findUnique({
      where: {
        id: data.productId,
      },
    });

  if (!product) {
    return {
      error: 'Product not found',
    };
  }

  if (!product.unitsPerCase) {
    return {
      error:
        'Product does not support case inventory',
    };
  }

  // ✅ CONVERT CASES → UNITS
  const unitsToAdd =
    data.cases * product.unitsPerCase;

  const updatedProduct =
    await this.prisma.product.update({
      where: {
        id: data.productId,
      },

      data: {
        stock: {
          increment: unitsToAdd,
        },
      },
    });

  // ✅ INVENTORY LOG
  await this.prisma.inventoryLog.create({
    data: {
      productId: product.id,
      storeId: product.storeId,

      ownerId:
        user.type === 'owner'
          ? user.ownerId
          : null,

      employeeId:
        user.type === 'employee'
          ? user.employeeId
          : null,

      change: unitsToAdd,

      reason:
        data.reason ||
        `Received ${data.cases} case(s)`,
    },
  });

  return {
    message: 'Case inventory received',

    casesReceived: data.cases,

    unitsAdded: unitsToAdd,

    product: updatedProduct,
  };
}

//
// CASE INVENTORY BREAKDOWN
//
async getCaseBreakdown(
  productId: string,
) {

  const product =
    await this.prisma.product.findUnique({
      where: {
        id: productId,
      },
    });

  if (!product) {
    return {
      error: 'Product not found',
    };
  }

  if (!product.unitsPerCase) {
    return {
      error:
        'Product does not use case inventory',
    };
  }

  const fullCases =
    Math.floor(
      product.stock / product.unitsPerCase,
    );

  const remainingUnits =
    product.stock % product.unitsPerCase;

  return {
    productId: product.id,
    productName: product.name,

    totalUnits: product.stock,

    unitsPerCase:
      product.unitsPerCase,

    fullCases,
    remainingUnits,
  };
}


}