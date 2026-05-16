import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { EmployeeService } from './employee.service';

import { JwtGuard } from '../auth/guards/jwt.guard';

@Controller('employee')
export class EmployeeController {

  constructor(
    private readonly employeeService:
      EmployeeService,
  ) {}

  //
  // CREATE EMPLOYEE
  //
  @UseGuards(JwtGuard)
  @Post('create')
  createEmployee(
    @Body()
    body: {
      email: string;
      password: string;
      name?: string;
    },
  ) {

    return this.employeeService.createEmployee(
      body,
    );
  }

  //
  // EMPLOYEE LOGIN
  //
  @Post('login')
  loginEmployee(
    @Body()
    body: {
      email: string;
      password: string;
    },
  ) {

    return this.employeeService.loginEmployee(
      body.email,
      body.password,
    );
  }

  //
  // ASSIGN EMPLOYEE TO STORE
  //
  @UseGuards(JwtGuard)
  @Post('assign')
  assignEmployee(
    @Req() req: any,

    @Body()
    body: {
      employeeId: string;
      storeId: string;
      role: string;
    },
  ) {

    return this.employeeService.assignEmployee(
      req.user.ownerId,
      body,
    );
  }

  //
  // GET STORE EMPLOYEES
  //
  @UseGuards(JwtGuard)
  @Get('store/:storeId')
  getStoreEmployees(
    @Req() req: any,

    @Param('storeId')
    storeId: string,
  ) {

    return this.employeeService.getStoreEmployees(
      req.user.ownerId,
      storeId,
    );
  }
}