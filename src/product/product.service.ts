import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductService {

  constructor(
    private prisma: PrismaService,
  ) {}

  //
  // ROUND MONEY
  //
  roundMoney(value: number) {

    return Number(value.toFixed(2));
  }

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

    return {
      message: 'Product created',
      product,
    };
  }

  //
  // CREATE MULTI PACK
  //
  async createMultiPack(
    ownerId: string,

    data: {
      productId: string;

      quantity: number;

      price: number;
    },
  ) {

    const product =
      await this.prisma.product.findUnique({
        where: {
          id: data.productId,
        },

        include: {
          store: true,
        },
      });

    if (!product) {
      return {
        error: 'Product not found',
      };
    }

    if (
      product.store.ownerId !== ownerId
    ) {
      return {
        error: 'Unauthorized',
      };
    }

    const existingPack =
      await this.prisma.productMultiPack.findFirst({
        where: {
          productId: data.productId,
          quantity: data.quantity,
        },
      });

    if (existingPack) {
      return {
        error:
          'Multi-pack already exists',
      };
    }

    const multiPack =
      await this.prisma.productMultiPack.create({
        data: {
          productId: data.productId,

          quantity: data.quantity,

          price: data.price,
        },
      });

    return {
      message:
        'Multi-pack created',

      multiPack,
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
          multiPacks: true,
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

      include: {
        multiPacks: true,
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

  //
  // VALIDATE INVENTORY SALE
  //
  async validateInventorySale(
    productId: string,
    quantity: number,
  ) {

    const product =
      await this.prisma.product.findUnique({
        where: {
          id: productId,
        },

        include: {
          store: true,
        },
      });

    if (!product) {
      return {
        valid: false,
        error: 'Product not found',
      };
    }

    const inventoryMode =
      product.store.inventoryMode;

    if (inventoryMode === 'none') {

      return {
        valid: true,
        inventoryMode,
      };
    }

    if (inventoryMode === 'strict') {

      if (product.stock < quantity) {

        return {
          valid: false,

          error:
            'Insufficient inventory',

          inventoryMode,
        };
      }

      return {
        valid: true,
        inventoryMode,
      };
    }

    if (inventoryMode === 'hybrid') {

      return {
        valid: true,
        inventoryMode,

        warning:
          product.stock < quantity
            ? 'Inventory will go negative'
            : null,
      };
    }

    return {
      valid: false,
      error: 'Invalid inventory mode',
    };
  }

  //
  // PROCESS INVENTORY SALE
  //
  async processInventorySale(
    user: any,

    data: {
      productId: string;
      quantity: number;
    },
  ) {

    const validation =
      await this.validateInventorySale(
        data.productId,
        data.quantity,
      );

    if (!validation.valid) {
      return validation;
    }

    const product =
      await this.prisma.product.findUnique({
        where: {
          id: data.productId,
        },

        include: {
          store: true,
        },
      });

    if (!product) {
      return {
        error: 'Product not found',
      };
    }

    if (
      product.store.inventoryMode === 'none'
    ) {

      return {
        message:
          'Inventory ignored',

        inventoryMode: 'none',
      };
    }

    const updatedProduct =
      await this.prisma.product.update({
        where: {
          id: data.productId,
        },

        data: {
          stock: {
            decrement: data.quantity,
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

        change: -data.quantity,

        reason: 'sale',
      },
    });

    return {
      message: 'Inventory updated',

      inventoryMode:
        product.store.inventoryMode,

      warning:
        validation.warning || null,

      product: updatedProduct,
    };
  }

  //
  // VALIDATE CART
  //
  async validateCart(
    storeId: string,

    items: {
      productId: string;
      quantity: number;
    }[],
  ) {

    let subtotal = 0;
    let taxTotal = 0;

    const validatedItems: any[] = [];

    for (const item of items) {

      const product =
        await this.prisma.product.findFirst({
          where: {
            id: item.productId,
            storeId,
          },

          include: {
            tax: true,
            store: true,
            multiPacks: true,
          },
        });

      if (!product) {

        return {
          valid: false,

          error:
            `Product not found: ${item.productId}`,
        };
      }

      const inventoryValidation =
        await this.validateInventorySale(
          product.id,
          item.quantity,
        );

      if (!inventoryValidation.valid) {

        return inventoryValidation;
      }

      let appliedPrice =
        product.price;

      const multiPack =
        product.multiPacks.find(
          (pack) =>
            pack.quantity === item.quantity,
        );

      let lineTotal = 0;

      if (multiPack) {

        lineTotal =
          this.roundMoney(
            multiPack.price,
          );

        appliedPrice =
          this.roundMoney(
            multiPack.price /
            item.quantity,
          );

      } else {

        lineTotal =
          this.roundMoney(
            product.price *
            item.quantity,
          );
      }

      let lineTax = 0;

      if (product.tax) {

        lineTax =
          this.roundMoney(
            lineTotal *
            product.tax.rate,
          );
      }

      subtotal += lineTotal;
      taxTotal += lineTax;

      validatedItems.push({
        productId: product.id,

        name: product.name,

        barcode: product.barcode,

        quantity: item.quantity,

        unitPrice:
          product.price,

        appliedPrice,

        lineTotal,

        lineTax,

        inventoryMode:
          product.store.inventoryMode,

        stock:
          product.stock,

        multiPackApplied:
          multiPack
            ? {
                quantity:
                  multiPack.quantity,

                totalPrice:
                  multiPack.price,
              }
            : null,

        warning:
          inventoryValidation.warning || null,
      });
    }

    return {
      valid: true,

      items: validatedItems,

      subtotal:
        this.roundMoney(subtotal),

      tax:
        this.roundMoney(taxTotal),

      total:
        this.roundMoney(
          subtotal + taxTotal,
        ),
    };
  }
}