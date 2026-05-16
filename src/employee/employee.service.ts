import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class EmployeeService {

  constructor(
    private prisma: PrismaService,
  ) {}

  //
  // CREATE EMPLOYEE
  //
  async createEmployee(data: {
    email: string;
    password: string;
    name?: string;
  }) {

    const existingEmployee =
      await this.prisma.employee.findUnique({
        where: {
          email: data.email,
        },
      });

    if (existingEmployee) {
      return {
        error: 'Employee already exists',
      };
    }

    const hashedPassword =
      await bcrypt.hash(data.password, 10);

    const employee =
      await this.prisma.employee.create({
        data: {
          email: data.email,
          password: hashedPassword,
          name: data.name,
        },
      });

    const {
      password,
      ...safeEmployee
    } = employee;

    return {
      message: 'Employee created',
      employee: safeEmployee,
    };
  }

  //
  // EMPLOYEE LOGIN
  //
  async loginEmployee(
    email: string,
    password: string,
  ) {

    const employee =
      await this.prisma.employee.findUnique({
        where: { email },
      });

    if (!employee) {
      return {
        error: 'Invalid credentials',
      };
    }

    const validPassword =
      await bcrypt.compare(
        password,
        employee.password,
      );

    if (!validPassword) {
      return {
        error: 'Invalid credentials',
      };
    }

    const token = jwt.sign(
      {
        employeeId: employee.id,
        type: 'employee',
      },
      process.env.JWT_SECRET || 'secret',
      {
        expiresIn: '7d',
      },
    );

    const {
      password: _,
      ...safeEmployee
    } = employee;

    return {
      token,
      employee: safeEmployee,
    };
  }

  //
  // ASSIGN EMPLOYEE TO STORE
  //
  async assignEmployee(
    ownerId: string,

    data: {
      employeeId: string;
      storeId: string;
      role: string;
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

    const existingAssignment =
      await this.prisma.employeeStore.findFirst({
        where: {
          employeeId: data.employeeId,
          storeId: data.storeId,
        },
      });

    if (existingAssignment) {
      return {
        error:
          'Employee already assigned',
      };
    }

    const assignment =
      await this.prisma.employeeStore.create({
        data: {
          employeeId: data.employeeId,
          storeId: data.storeId,
          role: data.role,
        },
      });

    return {
      message: 'Employee assigned',
      assignment,
    };
  }

  //
  // GET STORE EMPLOYEES
  //
  async getStoreEmployees(
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

    const employees =
      await this.prisma.employeeStore.findMany({
        where: {
          storeId,
        },

        include: {
          employee: {
            select: {
              id: true,
              email: true,
              name: true,
              isActive: true,
              createdAt: true,
            },
          },
        },
      });

    return employees;
  }
}