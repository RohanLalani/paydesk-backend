import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ShiftService {

  constructor(
    private prisma: PrismaService,
  ) {}

  //
  // START SHIFT
  //
  async startShift(
    user: any,

    data: {
      storeId: string;
    },
  ) {

    //
    // OWNER SHIFT
    //
    if (user.type === 'owner') {

      // ✅ CHECK ACTIVE SHIFT
      const existingShift =
        await this.prisma.shift.findFirst({
          where: {
            ownerId: user.ownerId,
            endTime: null,
          },
        });

      if (existingShift) {
        return {
          error:
            'Owner already has active shift',
        };
      }

      // ✅ VERIFY STORE OWNERSHIP
      const store =
        await this.prisma.store.findFirst({
          where: {
            id: data.storeId,
            ownerId: user.ownerId,
          },
        });

      if (!store) {
        return {
          error:
            'Store not found or unauthorized',
        };
      }

      const shift =
        await this.prisma.shift.create({
          data: {
            ownerId: user.ownerId,
            storeId: data.storeId,
          },
        });

      return {
        message: 'Shift started',
        shift,
      };
    }

    //
    // EMPLOYEE SHIFT
    //
    if (user.type === 'employee') {

      // ✅ CHECK ACTIVE SHIFT
      const existingShift =
        await this.prisma.shift.findFirst({
          where: {
            employeeId: user.employeeId,
            endTime: null,
          },
        });

      if (existingShift) {
        return {
          error:
            'Employee already has active shift',
        };
      }

      // ✅ VERIFY EMPLOYEE ASSIGNED
      const assignment =
        await this.prisma.employeeStore.findFirst({
          where: {
            employeeId: user.employeeId,
            storeId: data.storeId,
          },
        });

      if (!assignment) {
        return {
          error:
            'Employee not assigned to store',
        };
      }

      const shift =
        await this.prisma.shift.create({
          data: {
            employeeId: user.employeeId,
            storeId: data.storeId,
          },
        });

      return {
        message: 'Shift started',
        shift,
      };
    }

    return {
      error: 'Invalid user type',
    };
  }

  //
  // END SHIFT
  //
  async endShift(user: any) {

    //
    // OWNER
    //
    if (user.type === 'owner') {

      const shift =
        await this.prisma.shift.findFirst({
          where: {
            ownerId: user.ownerId,
            endTime: null,
          },
        });

      if (!shift) {
        return {
          error: 'No active shift',
        };
      }

      const updatedShift =
        await this.prisma.shift.update({
          where: {
            id: shift.id,
          },

          data: {
            endTime: new Date(),
          },
        });

      return {
        message: 'Shift ended',
        shift: updatedShift,
      };
    }

    //
    // EMPLOYEE
    //
    if (user.type === 'employee') {

      const shift =
        await this.prisma.shift.findFirst({
          where: {
            employeeId: user.employeeId,
            endTime: null,
          },
        });

      if (!shift) {
        return {
          error: 'No active shift',
        };
      }

      const updatedShift =
        await this.prisma.shift.update({
          where: {
            id: shift.id,
          },

          data: {
            endTime: new Date(),
          },
        });

      return {
        message: 'Shift ended',
        shift: updatedShift,
      };
    }

    return {
      error: 'Invalid user type',
    };
  }

  //
  // CURRENT SHIFT
  //
  async currentShift(user: any) {

    if (user.type === 'owner') {

      return this.prisma.shift.findFirst({
        where: {
          ownerId: user.ownerId,
          endTime: null,
        },
      });
    }

    if (user.type === 'employee') {

      return this.prisma.shift.findFirst({
        where: {
          employeeId: user.employeeId,
          endTime: null,
        },
      });
    }

    return null;
  }
}