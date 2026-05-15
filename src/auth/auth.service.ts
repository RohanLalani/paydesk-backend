import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  //
  // OWNER REGISTER
  //
  async registerOwner(data: {
    email: string;
    password: string;
    name?: string;
  }) {

    const existingOwner =
      await this.prisma.owner.findUnique({
        where: {
          email: data.email,
        },
      });

    if (existingOwner) {
      return {
        error: 'Owner already exists',
      };
    }

    const hashedPassword =
      await bcrypt.hash(data.password, 10);

    const owner =
      await this.prisma.owner.create({
        data: {
          email: data.email,
          password: hashedPassword,
          name: data.name,
        },
      });

    // ✅ REMOVE PASSWORD FROM RESPONSE
    const { password, ...safeOwner } = owner;

    return {
      message: 'Owner created',
      owner: safeOwner,
    };
  }

  //
  // OWNER LOGIN
  //
  async loginOwner(
    email: string,
    password: string,
  ) {

    const owner =
      await this.prisma.owner.findUnique({
        where: { email },
      });

    if (!owner) {
      return {
        error: 'Invalid credentials',
      };
    }

    const validPassword =
      await bcrypt.compare(
        password,
        owner.password,
      );

    if (!validPassword) {
      return {
        error: 'Invalid credentials',
      };
    }

    const token = jwt.sign(
      {
        ownerId: owner.id,
        type: 'owner',
      },
      process.env.JWT_SECRET || 'secret',
      {
        expiresIn: '7d',
      },
    );

    // ✅ REMOVE PASSWORD FROM RESPONSE
    const { password: _, ...safeOwner } = owner;

    return {
      token,
      owner: safeOwner,
    };
  }
}