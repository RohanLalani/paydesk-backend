import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoreService {

  constructor(
    private prisma: PrismaService,
  ) {}

  //
  // CREATE STORE
  //
  async createStore(
    ownerId: string,
    data: {
      name: string;
      inventoryMode?: string;
    },
  ) {

    const store =
      await this.prisma.store.create({
        data: {
          name: data.name,

          inventoryMode:
            data.inventoryMode || 'hybrid',

          ownerId,
        },
      });

    return {
      message: 'Store created',
      store,
    };
  }

  //
  // GET OWNER STORES
  //
  async getOwnerStores(ownerId: string) {

    const stores =
      await this.prisma.store.findMany({
        where: {
          ownerId,
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    return stores;
  }
}