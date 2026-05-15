import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  // ✅ REGISTER
  async register(data: {
    email: string;
    password: string;
    role: string;
    name?: string;
  }) {
    const existingUser = await this.prisma.user.findUnique({
      where: {
        email: data.email,
      },
    });

    if (existingUser) {
      return {
        error: 'User already exists',
      };
    }

    const hashedPassword = await bcrypt.hash(
      data.password,
      10,
    );

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        password: hashedPassword,
        role: data.role,
        name: data.name,
      },
    });

    return {
      message: 'User created',
      user,
    };
  }

  // ✅ LOGIN
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return {
        error: 'Invalid credentials',
      };
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password,
    );

    if (!validPassword) {
      return {
        error: 'Invalid credentials',
      };
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      process.env.JWT_SECRET || 'secret',
      {
        expiresIn: '7d',
      },
    );

    return {
      token,
      user,
    };
  }
}